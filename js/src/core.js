// Recording calls: tags, budgets, the local ledger and the background sender. Nothing here runs in
// your request path except an in-memory budget check and an array push; send failures never throw.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { lookup, priceBook, priceCall, providerOf } from "./pricing.js";

/**
 * Who bills a call: the host it names (Azure for its OpenAI models), except "openai", which OpenAI-compatible
 * clients report whatever the host, so the model's own provider bills those. A provider the price book doesn't
 * know (your own servers) stays as given, priced at list until it has a custom price.
 */
function billedBy(provider, price) {
  const named = providerOf(provider);
  if (!price) return named ?? String(provider ?? "unknown").toLowerCase();
  if (provider && String(provider).toLowerCase() !== "unknown" && !named) return String(provider).toLowerCase();
  return named && named !== "openai" ? named : price.provider;
}

const TAG_KEYS = ["customer", "feature", "user", "project", "environment", "run"];

/** A provider key's last four characters: all Veqen ever sees of it, matched to the provider's own key list. */
export const keyHint = (key) => (typeof key === "string" && key.length >= 16 && /^[A-Za-z0-9_+/=.-]{4}$/.test(key.slice(-4)) ? key.slice(-4) : undefined);
const storage = new AsyncLocalStorage();

export class BudgetExceeded extends Error {
  constructor(scope, value, limitUsd) {
    super(`Veqen budget exceeded for ${scope}=${value} (limit $${limitUsd.toFixed(2)})`);
    this.name = "BudgetExceeded";
    Object.assign(this, { scope, value, limitUsd });
  }
}

const state = {
  apiKey: "",
  endpoint: "https://veqen-app.com",
  environment: undefined,
  ledgerFile: undefined,
  queue: [],
  budgets: [],
  blocked: new Map(),
  timer: null,
  configured: false,
  sending: null,
  lastPoll: 0,
  budgetPollMs: 30_000,
};

const env = (name) => (typeof process !== "undefined" ? process.env?.[name] : undefined);

/** Configure Veqen. Without an API key, costs are computed locally and nothing is sent. */
export function init(options = {}) {
  state.apiKey = options.apiKey ?? env("VEQEN_API_KEY") ?? "";
  state.endpoint = (options.endpoint ?? env("VEQEN_ENDPOINT") ?? state.endpoint).replace(/\/$/, "");
  state.environment = options.environment ?? env("VEQEN_ENVIRONMENT");
  state.ledgerFile = options.ledgerFile ?? env("VEQEN_LEDGER_FILE");
  if (state.ledgerFile) {
    try {
      mkdirSync(dirname(state.ledgerFile), { recursive: true });
    } catch (error) {
      console.warn(`[veqen] can't create the ledger folder: ${error.message}`); // e.g. a read-only filesystem
    }
  }
  state.budgetPollMs = options.budgetPollMs ?? state.budgetPollMs;
  state.configured = true;
  clearInterval(state.timer);
  state.timer = null;
  if (state.apiKey) {
    state.timer = setInterval(() => void flush(), options.flushIntervalMs ?? 2000);
    state.timer.unref?.();
    globalThis.process?.once?.("beforeExit", () => void flush());
  }
}

const ensure = () => state.configured || init();

/** Attribute every call made inside `fn`: `await withTags({ customer: "acme" }, () => ...)`. */
export function withTags(tags, fn) {
  const clean = Object.fromEntries(Object.entries(tags).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  return storage.run({ ...currentTags(), ...clean }, fn);
}

export const currentTags = () => ({ ...(storage.getStore() ?? {}) });

const periodKey = (period) => new Date().toISOString().slice(0, period === "day" ? 10 : 7);

function applies(budget, tags) {
  if (budget.scope === "org") return "*";
  const value = tags[budget.scope];
  return value != null && (budget.value === "*" || budget.value === value) ? value : null;
}

/** A local, in-process budget. `{ customer: "*" }` gives every customer their own limit, `{ project: "*" }` every project. */
export function budget(limitUsd, { customer, feature, user, project, period = "month", mode = "block" } = {}) {
  const scopes = Object.entries({ customer, feature, user, project }).filter(([, v]) => v != null);
  if (scopes.length > 1 || !["month", "day"].includes(period) || !["block", "warn"].includes(mode)) {
    throw new Error("Use one of customer/feature/user/project, period 'month' or 'day', mode 'block' or 'warn'");
  }
  const [scope, value] = scopes[0] ?? ["org", "*"];
  state.budgets.push({ scope, value: String(value), limitUsd, period, mode, spent: new Map() });
}

export function check(tags) {
  for (const [key, limit] of state.blocked) {
    const [scope, value] = key.split("\u0000");
    if (scope === "org" || tags[scope] === value) throw new BudgetExceeded(scope, value, limit);
  }
  for (const b of state.budgets) {
    const value = applies(b, tags);
    if (value && b.mode === "block" && (b.spent.get(`${value}|${periodKey(b.period)}`) ?? 0) >= b.limitUsd) {
      throw new BudgetExceeded(b.scope, value, b.limitUsd);
    }
  }
}

/**
 * Record one call. `usage` takes inputTokens (uncached), outputTokens, cacheReadTokens, cacheWriteTokens,
 * cacheWrite1hTokens, audioInputTokens, audioOutputTokens and units: images for image models, seconds for
 * video and transcription, characters for speech, queries for rerank, pages for OCR. `variant` is an image
 * size and quality ("hd/1024x1792") or a video resolution ("1080p").
 */
export function record(provider, model, usage, { tags = currentTags(), batch = false, serviceTier, residency, variant, latencyMs, costUsd, providerKey, keyHint: hint = keyHint(providerKey) } = {}) {
  ensure();
  const u = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0,
    audioInputTokens: 0, audioOutputTokens: 0, units: 0, ...usage,
  };
  const used = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.cacheWrite1hTokens +
    u.audioInputTokens + u.audioOutputTokens + u.units;
  const price = lookup(model, provider);
  // A call that reported no usage keeps the cost it came with, rather than pricing at zero.
  if (price && (used || costUsd == null)) costUsd = priceCall(price, u, { batch, serviceTier, residency, variant }) ?? costUsd;
  const event = {
    id: crypto.randomUUID().replaceAll("-", ""),
    ts: new Date().toISOString(),
    provider: billedBy(provider, price),
    model: price?.model ?? model,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_tokens: u.cacheReadTokens,
    cache_write_tokens: u.cacheWriteTokens,
    cache_write_1h_tokens: u.cacheWrite1hTokens,
    audio_input_tokens: u.audioInputTokens,
    audio_output_tokens: u.audioOutputTokens,
    units: u.units,
    variant: variant ?? null,
    batch,
    service_tier: serviceTier ?? null,
    residency: residency ?? null,
    cost_usd: costUsd ?? null,
    price_version: priceBook.version,
    ...Object.fromEntries(TAG_KEYS.filter((k) => tags[k] != null).map((k) => [k, tags[k]])),
    environment: tags.environment ?? state.environment ?? null,
    tags: Object.fromEntries(Object.entries(tags).filter(([k]) => !TAG_KEYS.includes(k))),
    latency_ms: latencyMs ?? null,
    status: "ok",
    ...(hint ? { key_hint: hint } : {}),
  };
  if (costUsd) {
    for (const b of state.budgets) {
      const value = applies(b, tags);
      if (value) {
        const key = `${value}|${periodKey(b.period)}`;
        const before = b.spent.get(key) ?? 0;
        b.spent.set(key, before + costUsd);
        if (b.mode === "warn" && before < b.limitUsd && before + costUsd >= b.limitUsd) {
          console.warn(`[veqen] budget reached for ${b.scope}=${value}: $${(before + costUsd).toFixed(2)} of $${b.limitUsd.toFixed(2)} this ${b.period}`);
        }
      }
    }
  }
  if (state.ledgerFile) {
    try {
      appendFileSync(state.ledgerFile, JSON.stringify(event) + "\n");
    } catch (error) {
      console.warn(`[veqen] couldn't write the ledger file: ${error.message}`); // never break the caller
    }
  }
  if (state.apiKey) {
    if (state.queue.length >= 50_000) state.queue.shift();
    state.queue.push(event);
  }
  return event;
}

async function request(method, path, body) {
  const headers = { Authorization: `Bearer ${state.apiKey}`, "User-Agent": "veqen-js/1.0" };
  let payload;
  if (body) {
    headers["Content-Type"] = "application/json";
    // Front Door WAF cannot inspect compressed request bodies.
    payload = JSON.stringify(body);
  }
  return fetch(state.endpoint + path, { method, headers, body: payload, signal: AbortSignal.timeout(10_000) });
}

async function pollBudgets() {
  state.lastPoll = Date.now();
  try {
    const response = await request("GET", "/v1/budgets/status");
    if (response.ok) {
      const { blocked = [] } = await response.json();
      state.blocked = new Map(blocked.map((b) => [`${b.scope}\u0000${b.value}`, b.limit_usd]));
    }
  } catch {
    // keep the last known state
  }
}

async function send() {
  if (Date.now() - state.lastPoll >= state.budgetPollMs) await pollBudgets();
  while (state.queue.length) {
    const batch = [];
    let bytes = 13; // {"events":[]} plus comma separators
    for (const event of state.queue.slice(0, 500)) {
      const size = Buffer.byteLength(JSON.stringify(event)) + (batch.length ? 1 : 0);
      if (bytes + size > 64 * 1024) break;
      batch.push(event);
      bytes += size;
    }
    if (!batch.length) {
      console.warn("[veqen] rejected an event exceeding the 64 KiB upload limit; shorten its tags");
      state.queue.shift();
      continue;
    }
    let response;
    try {
      response = await request("POST", "/v1/events", { events: batch });
    } catch {
      return; // network trouble: keep the events for the next cycle
    }
    if (response.status === 429 || response.status >= 500) return;
    if (!response.ok) console.warn(`[veqen] rejected ${batch.length} events (HTTP ${response.status})`);
    state.queue.splice(0, batch.length);
  }
}

/** Send everything queued. Await it before a serverless function returns. */
export function flush() {
  if (!state.apiKey) return Promise.resolve(true);
  state.sending ??= send().finally(() => (state.sending = null));
  return state.sending.then(() => state.queue.length === 0);
}

/** Test support: forget configuration, budgets and queued events. */
export function _reset() {
  clearInterval(state.timer);
  Object.assign(state, { apiKey: "", ledgerFile: undefined, queue: [], budgets: [], blocked: new Map(), timer: null, configured: false, lastPoll: 0 });
}
