// veqen.wrap(client): exact cost on every OpenAI, Anthropic and Google GenAI call, including OpenAI clients
// pointed at other hosts (Together, Fireworks, Groq, DeepInfra, xAI...) and the image, speech, transcription
// and embedding endpoints. A thin Proxy that only intercepts methods producing model output and reads the
// usage the provider already returns.
import { check, currentTags, keyHint, record } from "./core.js";
import { lookup, providerForUrl } from "./pricing.js";

const MEDIA = ["images.generate", "images.edit", "audio.speech.create", "audio.transcriptions.create", "audio.translations.create"];
const METHODS = {
  openai: ["chat.completions.create", "chat.completions.stream", "responses.create", "responses.stream", "embeddings.create", ...MEDIA],
  anthropic: ["messages.create", "messages.stream", "beta.messages.create"],
  google: ["models.generateContent", "models.generateContentStream"],
};
const FINAL = ["finalChatCompletion", "finalResponse", "finalMessage"];
const n = (v) => Number(v ?? 0);

const EXTRACT = {
  openai(obj) {
    obj = obj?.response ?? obj; // Responses API stream events wrap the response
    const u = obj?.usage;
    if (!u) return null;
    const chat = "prompt_tokens" in u;
    const cached = n(chat ? u.prompt_tokens_details?.cached_tokens : u.input_tokens_details?.cached_tokens);
    const input = n(chat ? u.prompt_tokens : u.input_tokens) - cached;
    return { model: obj.model, usage: { inputTokens: input, outputTokens: n(chat ? u.completion_tokens : u.output_tokens), cacheReadTokens: cached }, tier: obj.service_tier };
  },
  // Images by count (or their exact tokens when reported), speech by characters, transcription by seconds or tokens.
  media(obj, params, path) {
    const u = obj?.usage;
    if (path.startsWith("images.")) {
      const units = obj?.data?.length || n(params.n || 1);
      const variant = [params.quality, params.size].filter((x) => x && x !== "auto").join("/") || undefined;
      const usage = u?.input_tokens != null ? { inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens), units } : { units };
      return { model: params.model, usage, variant };
    }
    if (path === "audio.speech.create") return { model: params.model, usage: { units: String(params.input ?? "").length } };
    if (u?.type === "tokens") {
      const audio = n(u.input_token_details?.audio_tokens);
      return { model: params.model, usage: { inputTokens: n(u.input_tokens) - audio, outputTokens: n(u.output_tokens), audioInputTokens: audio } };
    }
    const seconds = n(u?.seconds ?? obj?.duration);
    return seconds ? { model: params.model, usage: { units: seconds } } : null;
  },
  anthropic(obj) {
    const u = obj?.usage;
    if (!u) return null;
    const oneHour = n(u.cache_creation?.ephemeral_1h_input_tokens);
    return {
      model: obj.model,
      usage: { inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens), cacheReadTokens: n(u.cache_read_input_tokens), cacheWriteTokens: n(u.cache_creation_input_tokens) - oneHour, cacheWrite1hTokens: oneHour },
      tier: u.service_tier,
    };
  },
  google(obj) {
    const m = obj?.usageMetadata;
    if (!m) return null;
    const cached = n(m.cachedContentTokenCount);
    return { model: obj.modelVersion, usage: { inputTokens: n(m.promptTokenCount) - cached, outputTokens: n(m.candidatesTokenCount) + n(m.thoughtsTokenCount), cacheReadTokens: cached } };
  },
};

function accumulator(provider, done) {
  let found = null;
  let start = null;
  return {
    feed(item) {
      if (provider === "anthropic") {
        if (item?.type === "message_start") start = found = EXTRACT.anthropic(item.message);
        else if (item?.type === "message_delta" && item.usage && start) {
          found = { ...start, usage: { ...start.usage, outputTokens: n(item.usage.output_tokens) } };
        }
        return;
      }
      const extracted = EXTRACT[provider](item);
      if (extracted && (extracted.usage.inputTokens || extracted.usage.outputTokens)) found = extracted;
    },
    finish: () => done(found),
  };
}

async function* observe(stream, acc) {
  try {
    for await (const item of stream) {
      acc.feed(item);
      yield item;
    }
  } finally {
    acc.finish();
  }
}

function instrument(fn, target, provider, path, defaults, residency, host, hint) {
  return function veqenInstrumented(params = {}, ...rest) {
    const tags = { ...defaults, ...currentTags() };
    check(tags);
    if (provider === "openai" && path.startsWith("chat.") && params.stream) {
      params = { ...params, stream_options: { ...params.stream_options, include_usage: true } };
    }
    const started = performance.now();
    let emitted = false;
    const done = (found) => {
      if (emitted || !found) return; // no usage reported: nothing to price
      emitted = true;
      try {
        const source = host ?? provider;
        const model = found.model && (lookup(found.model, source) || !params.model) ? found.model : params.model;
        if (model) record(source, String(model), found.usage, { tags, serviceTier: found.tier, residency, variant: found.variant, latencyMs: Math.round(performance.now() - started), keyHint: hint });
      } catch (error) {
        console.warn(`[veqen] couldn't record a ${provider} call: ${error.message}`); // the call itself succeeded
      }
    };
    const result = fn.call(target, params, ...rest);
    if (path.endsWith(".stream")) {
      const finalName = FINAL.find((name) => typeof result?.[name] === "function");
      result?.[finalName]?.().then((final) => done(EXTRACT[provider](final)), () => {});
      return result;
    }
    return Promise.resolve(result).then((value) => {
      if (params.stream || path.endsWith("Stream")) {
        const acc = accumulator(provider, done);
        return new Proxy(value, {
          get(obj, key) {
            if (key === Symbol.asyncIterator) return () => observe(obj, acc)[Symbol.asyncIterator]();
            const v = Reflect.get(obj, key, obj);
            return typeof v === "function" ? v.bind(obj) : v;
          },
        });
      }
      done(MEDIA.includes(path) ? EXTRACT.media(value, params, path) : EXTRACT[provider](value));
      return value;
    });
  };
}

function proxy(target, provider, prefix, defaults, residency, host, hint) {
  return new Proxy(target, {
    get(obj, key, receiver) {
      const value = Reflect.get(obj, key, receiver);
      if (typeof key !== "string") return value;
      const path = prefix ? `${prefix}.${key}` : key;
      const methods = METHODS[provider];
      if (methods.includes(path) && typeof value === "function") return instrument(value, obj, provider, path, defaults, residency, host, hint);
      if (value && typeof value === "object" && methods.some((m) => m.startsWith(path + "."))) return proxy(value, provider, path, defaults, residency, host, hint);
      return value;
    },
  });
}

function detect(client) {
  const name = client?.constructor?.name ?? "";
  if (/OpenAI/.test(name)) return "openai";
  if (/Anthropic/.test(name)) return "anthropic";
  if (/GoogleGenAI/.test(name)) return "google";
  throw new TypeError(`veqen.wrap() supports OpenAI, Anthropic and Google GenAI clients, not ${name || typeof client}`);
}

/**
 * Return `client` with every model call priced and attributed. OpenAI-compatible clients pointed at another
 * host are priced as that host's models; pass `provider` for a host Veqen doesn't recognize.
 */
export function wrap(client, { residency, provider, ...defaultTags } = {}) {
  const tags = Object.fromEntries(Object.entries(defaultTags).map(([k, v]) => [k, String(v)]));
  const family = detect(client);
  // Anthropic's clients for the clouds bill through the cloud, whose regional hosts no URL map can list
  const cloud = { AnthropicBedrock: "bedrock", AnthropicVertex: "google" }[client?.constructor?.name];
  const host = provider ?? cloud ?? providerForUrl(client?.baseURL);
  // OpenAI, Anthropic, Anthropic on Bedrock and Google GenAI keep the key in different places; only its last four characters are sent
  const hint = keyHint(client?.apiKey ?? client?.awsAccessKey ?? client?.apiClient?.clientOptions?.apiKey);
  return proxy(client, family, "", tags, residency, host && host !== family ? host : undefined, hint);
}
