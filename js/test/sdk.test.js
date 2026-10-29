import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { budget, BudgetExceeded, checkSpend, cost, flush, init, lookup, providerForUrl, record, unitRate, withTags, wrap } from "../src/index.js";
import { veqen as middleware } from "../src/ai-sdk.js";
import { scan } from "../src/cli.js";
import { _reset } from "../src/core.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
afterEach(() => _reset());

function ledger() {
  const file = join(mkdtempSync(join(tmpdir(), "veqen-")), "ledger.jsonl");
  init({ ledgerFile: file });
  return () => {
    try {
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
}

class OpenAI {
  constructor(create) {
    this.chat = { completions: { create } };
    this.models = { list: () => ["m"] };
  }
}
class Anthropic {
  constructor(messages) {
    this.messages = messages;
  }
}
class GoogleGenAI {
  constructor(models) {
    this.models = models;
  }
}
const chatCompletion = { model: "gpt-4o-2024-08-06", usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } } };

test("pricing matches the Python engine for caching, batch, tiers and residency", () => {
  close(cost("gpt-4o", { inputTokens: 1000, outputTokens: 500 }), 0.0075);
  close(cost("gpt-4o", { inputTokens: 1_000_000 }, { batch: true }), 1.25);
  close(cost("claude-haiku-5-5", { inputTokens: 50_000, outputTokens: 1000, cacheReadTokens: 60_000 }), (50_000 * 0.5 + 1000 * 2.5 + 60_000 * 0.05) / 1e6);
  close(cost("claude-sonnet-4-5", { inputTokens: 1_000_000 }, { residency: "us" }), 3.3);
  assert.equal(lookup("us.anthropic.claude-sonnet-4-5-20250929-v1:0").key, "anthropic/claude-sonnet-4-5-20250929");
  assert.equal(lookup("deepseek-chat", "openai").key, "deepseek/deepseek-chat");
  assert.equal(cost("my-finetune", { inputTokens: 1 }), null);
});

test("models billed per unit, variants, audio tokens and host ids", () => {
  const image = lookup("gpt-image-1");
  assert.deepEqual([image.kind, image.unit], ["image", "image"]);
  close(cost("gpt-image-1", { units: 3 }, { variant: "high/1024-x-1024" }), 3 * unitRate(image, "high/1024x1024"));
  close(cost("gpt-image-1", { inputTokens: 1000, outputTokens: 4000, units: 1 }), cost("gpt-image-1", { inputTokens: 1000, outputTokens: 4000 }));
  close(cost("whisper-1", { units: 600 }), 0.06);
  close(cost("tts-1", { units: 1_000_000 }), 15);
  close(cost("rerank-v3.5", {}, { provider: "cohere" }), unitRate(lookup("rerank-v3.5", "cohere")));
  const std = lookup("gpt-realtime").rates.standard;
  close(cost("gpt-realtime", { inputTokens: 100, outputTokens: 50, audioInputTokens: 4000, audioOutputTokens: 2000 }),
        (100 * std.in + 4000 * std.ain + 50 * std.out + 2000 * std.aout) / 1e6);
  assert.equal(cost("veo-3.1-generate-001", { inputTokens: 1000 }), null);
  assert.equal(lookup("Qwen/Qwen3.5-9B", "together").key, "together/Qwen/Qwen3.5-9B");
  assert.equal(lookup("openai/gpt-oss-120b", "groq").key, "groq/openai/gpt-oss-120b");
  assert.equal(lookup("Llama-4-Maverick-17B-128E-Instruct-FP8").key, "azure-ai/Llama-4-Maverick-17B-128E-Instruct-FP8"); // exact case wins
  assert.equal(providerForUrl("https://api.together.xyz/v1"), "together");
  assert.equal(providerForUrl("http://vllm.internal:8000/v1"), null);
});

test("Azure OpenAI calls are Azure's, at OpenAI's prices", async () => {
  const events = ledger();
  class AzureOpenAI {
    constructor() {
      this.baseURL = "https://acme-east.openai.azure.com/openai/v1";
      this.chat = { completions: { create: async () => ({ model: "gpt-4o", usage: { prompt_tokens: 1200, completion_tokens: 300 } }) } };
    }
  }
  await wrap(new AzureOpenAI()).chat.completions.create({ model: "gpt-4o" });
  const [call] = events();
  assert.equal(call.provider, "azure-ai");
  close(call.cost_usd, (1200 * 2.5 + 300 * 10) / 1e6);
});

test("Anthropic on Bedrock is Bedrock's bill", async () => {
  const events = ledger();
  class AnthropicBedrock {
    constructor() {
      this.messages = { create: async () => ({ model: "anthropic.claude-sonnet-4-5-20250929-v1:0", usage: { input_tokens: 100, output_tokens: 10 } }) };
    }
  }
  await wrap(new AnthropicBedrock()).messages.create({ model: "anthropic.claude-sonnet-4-5-20250929-v1:0" });
  const [call] = events();
  assert.equal(call.provider, "bedrock");
  assert.ok(call.cost_usd > 0);
});

test("wrap prices media calls and OpenAI-compatible hosts", async () => {
  const events = ledger();
  class OpenAIMedia {
    constructor() {
      this.baseURL = "https://api.together.xyz/v1";
      this.chat = { completions: { create: async () => ({ model: "Qwen/Qwen3.5-9B", usage: { prompt_tokens: 1200, completion_tokens: 300 } }) } };
      this.images = { generate: async () => ({ data: [1, 2] }) };
      this.audio = { speech: { create: async () => "mp3" }, transcriptions: { create: async () => ({ usage: { type: "duration", seconds: 90 } }) } };
    }
  }
  const client = wrap(new OpenAIMedia(), { project: "genomics" });
  await client.chat.completions.create({ model: "Qwen/Qwen3.5-9B" });
  await client.images.generate({ model: "gpt-image-1", n: 2, size: "1024x1024", quality: "high" });
  await client.audio.speech.create({ model: "tts-1", input: "Hello there" });
  await client.audio.transcriptions.create({ model: "whisper-1" });
  record("fal", "fal-ai/flux/dev", {}, { costUsd: 0.07 });
  record("unknown", "gpt-4o-mini", { inputTokens: 10, outputTokens: 5 });
  const [chat, image, speech, transcript, reported, unstated] = events();
  assert.equal(unstated.provider, "openai");
  assert.deepEqual([chat.provider, chat.model, chat.project], ["together", "Qwen/Qwen3.5-9B", "genomics"]);
  assert.ok(chat.cost_usd > 0);
  assert.deepEqual([image.units, image.variant], [2, "high/1024x1024"]);
  close(image.cost_usd, 2 * unitRate(lookup("gpt-image-1"), "high/1024x1024"));
  close(speech.cost_usd, (11 * 15) / 1e6);
  close(transcript.cost_usd, 0.009);
  close(reported.cost_usd, 0.07);
});

test("wrap prices OpenAI calls and applies tags", async () => {
  const events = ledger();
  const client = wrap(new OpenAI(async () => chatCompletion), { feature: "support" });
  const result = await withTags({ customer: "acme" }, () => client.chat.completions.create({ model: "gpt-4o" }));
  assert.equal(result.model, "gpt-4o-2024-08-06");
  const [event] = events();
  assert.deepEqual([event.input_tokens, event.cache_read_tokens, event.output_tokens, event.customer, event.feature], [1000, 200, 300, "acme", "support"]);
  close(event.cost_usd, (1000 * 2.5 + 200 * 1.25 + 300 * 10) / 1e6);
  assert.deepEqual(client.models.list(), ["m"]);
});

test("calls carry only the last four characters of the provider key", async () => {
  const events = ledger();
  const client = new OpenAI(async () => chatCompletion);
  client.apiKey = "sk-proj-abcdefghijklmnop1x9Z";
  await wrap(client).chat.completions.create({ model: "gpt-4o" });
  record("openai", "gpt-4o", { inputTokens: 10 }, { providerKey: "sk-ant-api03-zzzzzzzzzzzz-Q_7w" });
  record("openai", "gpt-4o", { inputTokens: 10 }, { providerKey: "short" });
  const [wrapped, manual, short] = events();
  assert.deepEqual([wrapped.key_hint, manual.key_hint, short.key_hint], ["1x9Z", "Q_7w", undefined]);
  assert.ok(!JSON.stringify(wrapped).includes("abcdefgh"));
});

test("streams request usage and record once when iteration ends", async () => {
  const events = ledger();
  let params;
  async function* chunks() {
    yield { model: "gpt-4o", usage: null };
    yield { model: "gpt-4o", usage: chatCompletion.usage };
  }
  const client = wrap(new OpenAI(async (p) => ((params = p), chunks())));
  const stream = await client.chat.completions.create({ model: "gpt-4o", stream: true });
  for await (const _ of stream);
  assert.equal(params.stream_options.include_usage, true);
  assert.equal(events().length, 1);
});

test("Anthropic streams combine message_start and the final delta; stream helpers use finalMessage()", async () => {
  const events = ledger();
  async function* parts() {
    yield { type: "message_start", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } };
    yield { type: "message_delta", usage: { output_tokens: 250 } };
  }
  const final = { model: "claude-sonnet-4-5", usage: { input_tokens: 5, output_tokens: 7 } };
  const client = wrap(new Anthropic({ create: async () => parts(), stream: () => ({ finalMessage: async () => final }) }));
  for await (const _ of await client.messages.create({ model: "claude-sonnet-4-5", stream: true }));
  client.messages.stream({ model: "claude-sonnet-4-5" });
  await new Promise((r) => setTimeout(r, 10));
  const [first, second] = events();
  assert.deepEqual([first.input_tokens, first.cache_read_tokens, first.output_tokens], [100, 1000, 250]);
  assert.equal(second.output_tokens, 7);
});

test("Google GenAI usage metadata", async () => {
  const events = ledger();
  const client = wrap(new GoogleGenAI({ generateContent: async () => ({ modelVersion: "gemini-2.5-flash", usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 20 } }) }));
  await client.models.generateContent({ model: "gemini-2.5-flash" });
  const [event] = events();
  assert.deepEqual([event.provider, event.input_tokens, event.output_tokens], ["google", 400, 60]);
});

test("block budgets stop calls per customer before they are made", async () => {
  ledger();
  let calls = 0;
  const client = wrap(new OpenAI(async () => (calls++, chatCompletion)));
  budget(0.001, { customer: "*" });
  await withTags({ customer: "acme" }, async () => {
    await client.chat.completions.create({ model: "gpt-4o" });
    assert.throws(() => client.chat.completions.create({ model: "gpt-4o" }), BudgetExceeded);
  });
  await withTags({ customer: "other" }, () => client.chat.completions.create({ model: "gpt-4o" }));
  assert.equal(calls, 2);
});

test("AI SDK middleware reads v5 and v6 usage, including streams", async () => {
  const events = ledger();
  const mw = middleware({ feature: "chat" });
  const model = { provider: "openai.chat", modelId: "gpt-4o" };
  await mw.wrapGenerate({ model, doGenerate: async () => ({ usage: { inputTokens: 300, outputTokens: 20, cachedInputTokens: 100 } }) });
  const { stream } = await mw.wrapStream({
    model,
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "text-delta", delta: "hi" });
          c.enqueue({ type: "finish", usage: { inputTokens: { total: 50, cacheRead: 10, cacheWrite: 0 }, outputTokens: { total: 5 } } });
          c.close();
        },
      }),
    }),
  });
  for await (const _ of stream);
  const [a, b] = events();
  assert.deepEqual([a.input_tokens, a.cache_read_tokens, a.feature, b.input_tokens, b.output_tokens], [200, 100, "chat", 40, 5]);
});

test("LangChain.js handler reads standard usage metadata", async () => {
  const events = ledger();
  const { VeqenCallbackHandler } = await import("../src/langchain.js");
  const handler = new VeqenCallbackHandler({ feature: "rag" });
  handler.handleChatModelStart({}, [], "run-1", undefined, {}, [], { ls_provider: "anthropic" });
  handler.handleLLMEnd({ generations: [[{ message: { usage_metadata: { input_tokens: 1500, output_tokens: 200, input_token_details: { cache_read: 1000 } }, response_metadata: { model_name: "claude-sonnet-4-5" } } }]] }, "run-1");
  assert.deepEqual([events()[0].provider, events()[0].input_tokens], ["anthropic", 500]);
});

test("cloud mode sends JSON batches and enforces shared budgets", async () => {
  const received = [];
  const server = createServer((req, res) => {
    const body = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      if (req.method === "POST") {
        assert.equal(req.headers["content-encoding"], undefined);
        received.push(...JSON.parse(Buffer.concat(body)).events);
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.method === "GET" ? { blocked: [{ scope: "customer", value: "acme", limit_usd: 5 }] } : { accepted: 1 }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  init({ apiKey: "vq_live_test", endpoint: `http://127.0.0.1:${server.address().port}`, budgetPollMs: 0 });
  record("openai", "gpt-4o", { inputTokens: 10, outputTokens: 5 }, { tags: { customer: "acme" } });
  assert.equal(await flush(), true);
  server.close();
  assert.equal(received[0].customer, "acme");
  const client = wrap(new OpenAI(async () => chatCompletion));
  await withTags({ customer: "acme" }, async () => assert.throws(() => client.chat.completions.create({ model: "gpt-4o" }), BudgetExceeded));
});

test("scan finds model ids in string literals and API retirements", () => {
  const dir = mkdtempSync(join(tmpdir(), "veqen-scan-"));
  writeFileSync(join(dir, "app.py"), 'MODEL = "gpt-4o-2024-08-06"\nclient.beta.assistants.create()\nname = "o1 is not a model here"\n');
  const { models, apis } = scan(dir);
  assert.deepEqual(models.map((m) => [m.price.key, m.locations[0]]), [["openai/gpt-4o-2024-08-06", "app.py:1"]]);
  assert.equal(apis[0].name, "Assistants API");
});

test("diff reports model changes against a base ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "veqen-diff-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.py"), 'MODEL = "gpt-4o"\n');
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(join(dir, "app.py"), 'MODEL = "gpt-4o-mini"\n');
  git("commit", "-qam", "switch");
  const out = execFileSync(process.execPath, [join(import.meta.dirname, "..", "bin", "veqen.js"), "diff", "HEAD~1", "--format", "markdown"], { cwd: dir, encoding: "utf8", env: { ...process.env, VEQEN_API_KEY: "" } });
  assert.match(out, /veqen-cost-review/);
  assert.match(out, /openai\/gpt-4o \| openai\/gpt-4o-mini/);
});

test("diff never invokes repository diff drivers or text conversion programs", () => {
  const dir = mkdtempSync(join(tmpdir(), "veqen-diff-hooks-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitattributes"), "*.py diff=untrusted\n");
  writeFileSync(join(dir, "app.py"), 'MODEL = "gpt-4o"\n');
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(join(dir, "app.py"), 'MODEL = "gpt-4o-mini"\n');
  git("commit", "-qam", "switch");
  for (const hook of ["command", "textconv"]) {
    git("config", `diff.untrusted.${hook}`, "echo UNTRUSTED_DIFF_EXECUTED >&2; exit 99;");
    const out = execFileSync(process.execPath, [join(import.meta.dirname, "..", "bin", "veqen.js"), "diff", "HEAD~1", "--format", "json"], { cwd: dir, encoding: "utf8", env: { ...process.env, VEQEN_API_KEY: "" } });
    assert.equal(JSON.parse(out).changes[0][2], "openai/gpt-4o-mini");
    git("config", "--unset", `diff.untrusted.${hook}`);
  }
});

test("scan reads .env files, fails CI on near retirements even with --json, and help never crashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "veqen-cli-"));
  writeFileSync(join(dir, ".env"), 'MODEL="gpt-4o-2024-08-06"\n');
  const run = (...args) => {
    try {
      return { out: execFileSync(process.execPath, [join(import.meta.dirname, "..", "bin", "veqen.js"), ...args], { cwd: dir, encoding: "utf8" }), code: 0 };
    } catch (error) {
      return { out: error.stdout, code: error.status };
    }
  };
  assert.equal(JSON.parse(run("scan", "--json").out).models[0].locations[0], ".env:1");
  assert.equal(run("scan", "--json", "--fail-within", "100000").code, 1);
  assert.match(run("--help").out, /veqen scan/);
});

test("diff pairs every model swapped in a multi-line hunk", () => {
  const dir = mkdtempSync(join(tmpdir(), "veqen-diff2-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.py"), 'A = "gpt-4o"\nB = "claude-sonnet-4-5"\n');
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(join(dir, "app.py"), 'A = "gpt-4o-mini"\nB = "claude-haiku-4-5"\n');
  git("commit", "-qam", "switch");
  const out = execFileSync(process.execPath, [join(import.meta.dirname, "..", "bin", "veqen.js"), "diff", "HEAD~1", "--format", "json"], { cwd: dir, encoding: "utf8", env: { ...process.env, VEQEN_API_KEY: "" } });
  const froms = JSON.parse(out).changes.map((row) => row[1]);
  assert.deepEqual(froms, ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
});

test("an unwritable ledger and warn budgets never break calls", async () => {
  init({ ledgerFile: "/dev/null/nope/ledger.jsonl" });
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    budget(0.001, { mode: "warn" });
    const client = wrap(new OpenAI(async () => chatCompletion));
    await client.chat.completions.create({ model: "gpt-4o" });
    await client.chat.completions.create({ model: "gpt-4o" });
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((w) => w.includes("budget reached")));
});


test("cloud batches stay within the edge byte limit and preserve Unicode events", async () => {
  const received = [], sizes = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST") {
        const body = Buffer.concat(chunks);
        assert.equal(req.headers["content-encoding"], undefined);
        sizes.push(body.length);
        received.push(...JSON.parse(body).events);
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.method === "GET" ? {blocked: []} : {accepted: 1}));
    });
  });
  await new Promise(r => server.listen(0, r));
  try {
    init({apiKey: "vq_live_test", endpoint: `http://127.0.0.1:${server.address().port}`, flushIntervalMs: 60000});
    const expected = Array.from({length: 80}, () => record("openai", "gpt-4o", {inputTokens: 1}, {tags: {note: "🧪".repeat(600)}}));
    assert.equal(await flush(), true);
    assert.deepEqual(received, expected);
    assert.ok(sizes.length > 1);
    assert.ok(sizes.every(size => size <= 64 * 1024));
    record("openai", "gpt-4o", {inputTokens: 1}, {tags: {note: "x".repeat(65536)}});
    const valid = record("openai", "gpt-4o", {inputTokens: 1});
    assert.equal(await flush(), true);
    assert.equal(received.length, expected.length + 1);
    assert.deepEqual(received.at(-1), valid);
  } finally {
    server.close();
  }
});

test("coding-bill turns tool exports into a bill per team, offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "veqen-bill-"));
  writeFileSync(join(dir, "cursor.csv"), 'Date,User,Kind,Model,Cost\n2026-10-01,Ada@acme.test,Usage,gpt-5,"$1,204.50"\n2026-10-02,bo@acme.test,Usage,claude,12\n');
  writeFileSync(join(dir, "usage.csv"), "date,username,product,net_amount\n2026-10-01,ada@acme.test,copilot,19.00\n");
  writeFileSync(join(dir, "teams.csv"), "Email,Team\nada@acme.test,Platform\n");
  const out = execFileSync(process.execPath, ["bin/veqen.js", "coding-bill", join(dir, "cursor.csv"), `copilot=${join(dir, "usage.csv")}`, "--teams", join(dir, "teams.csv")],
    { encoding: "utf8" });
  assert.match(out, /Platform\s+1\s+\$1204\.50\s+\$19\.00\s+\$1223\.50/);
  assert.match(out, /No team\s+1\s+\$12\.00/);
  assert.match(out, /2 engineers and \$1235\.50 in all/);
});

test("coding-bill adds up files for one tool, reads paths with = in them, and says what a file lacks", () => {
  const dir = mkdtempSync(join(tmpdir(), "veqen-bill2-")), run = (...args) => execFileSync(process.execPath, ["bin/veqen.js", "coding-bill", ...args], { encoding: "utf8", stdio: "pipe" });
  mkdirSync(join(dir, "q=1"));
  writeFileSync(join(dir, "q=1", "cursor.csv"), "user,cost\nada@acme.test,10\n");
  writeFileSync(join(dir, "more.csv"), "user,cost\nada@acme.test,($5.00)\nbo@acme.test,7\n");
  const out = run(join(dir, "q=1", "cursor.csv"), `cursor=${join(dir, "more.csv")}`);
  assert.match(out, /No team\s+2\s+\$12\.00\s+\$12\.00/);  // one cursor column: 10 - 5 + 7
  writeFileSync(join(dir, "kiro.csv"), "date,email,credits\n2026-10-01,ada@acme.test,4\n");
  writeFileSync(join(dir, "broken.csv"), 'user,cost\nada@acme.test,"10\n');
  assert.throws(() => run(join(dir, "kiro.csv")), /needs a user or email column and a cost column \(an export in credits/);
  assert.throws(() => run(join(dir, "broken.csv")), /quote that's never closed/);
  writeFileSync(join(dir, "quoted.csv"), 'user,cost\nada "ace"@acme.test,4\n"bo@acme.test",n/a\n');
  assert.throws(() => run(join(dir, "quoted.csv")), /a cost that isn't a number: n\/a/);  // a quote inside a field is just a quote
  const relative = execFileSync(process.execPath, [join(process.cwd(), "bin/veqen.js"), "coding-bill", join("q=1", "cursor.csv")], { cwd: dir, encoding: "utf8" });
  assert.match(relative, /1 engineers and \$10\.00 in all/);  // q=1/cursor.csv is a file, not tool q
});

test("checkSpend asks Veqen, and fails closed when Veqen can't answer", async () => {
  assert.equal((await checkSpend({ agent: "bot", amount: 5 })).decision, "deny");
  let asked;
  const server = createServer((req, res) => {
    const body = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      asked = JSON.parse(Buffer.concat(body));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ decision: "approval", action_id: asked.action_id, reasons: ["A person approves anything over $1.00"], remaining_month_usd: 95 }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  init({ apiKey: "vq_live_test", endpoint: `http://127.0.0.1:${server.address().port}`, budgetPollMs: 0 });
  const answer = await withTags({ run: "run-1" }, () => checkSpend({ agent: "bot", amount: 5, payee: "Acme" }));
  server.close();
  assert.deepEqual([answer.decision, answer.allowed, answer.remainingMonthUsd, asked.run, asked.payee], ["approval", false, 95, "run-1", "Acme"]);
  init({ apiKey: "vq_live_test", endpoint: "http://127.0.0.1:9", budgetPollMs: 0 });
  assert.equal((await checkSpend({ agent: "bot", amount: 5 })).allowed, false);
  assert.equal((await checkSpend({ agent: "bot", amount: 5, onError: "allow" })).allowed, true);
});
