// npx @veqen/sdk <init|scan|diff|audit|report|coding-bill> — local, offline-first tooling for AI cost.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { lookup, priceBook, priceCall } from "./pricing.js";

const CODE = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rb", ".java", ".kt", ".cs", ".php", ".rs", ".yaml", ".yml", ".json", ".toml"]);
const isCode = (name) => CODE.has(extname(name)) || name === ".env" || name.startsWith(".env.");
const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", ".next", "__pycache__", "vendor", "target", "coverage"]);
const LITERAL = /["'`]([\w.:/@-]{2,100})["'`]/g;
const DEFAULT_CALL = { inputTokens: 2_000, outputTokens: 500 };
const usd = (v) => (v == null ? "—" : v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const daysUntil = (date) => Math.ceil((Date.parse(date) - Date.now()) / 86_400_000);
const knownModel = (literal) => (literal in priceBook.models || Object.keys(priceBook.models).some((k) => k.endsWith("/" + literal)) ? lookup(literal) : null);

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  return [line(headers), line(widths.map((w) => "─".repeat(w))), ...rows.map(line)].join("\n");
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const info = lstatSync(path); // symlinks are skipped: no broken links, no cycles
    if (info.isDirectory()) yield* files(path);
    else if (info.isFile() && isCode(name) && info.size < 1_000_000) yield path;
  }
}

function cheaper(price) {
  const blended = (p) => (p.rates.standard.in * 3 + p.rates.standard.out) / 4;
  const current = blended(price);
  return Object.entries(priceBook.models)
    .filter(([key, p]) => key.startsWith(price.provider + "/") && p.rates.standard && !(p.retires && daysUntil(p.retires) < 180))
    .map(([key, p]) => ({ key, cost: blended(p) }))
    .filter((c) => c.cost < current * 0.6 && !/\d{4}-?\d{2}-?\d{2}$/.test(c.key))
    .sort((a, b) => b.cost - a.cost)[0]?.key.split("/")[1];
}

export function scan(dir) {
  const found = new Map();
  const apis = [];
  for (const path of files(dir)) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(LITERAL)) {
      const price = knownModel(match[1]);
      if (!price) continue;
      const entry = found.get(price.key) ?? { price, locations: [] };
      entry.locations.push(`${relative(dir, path)}:${text.slice(0, match.index).split("\n").length}`);
      found.set(price.key, entry);
    }
    for (const rule of priceBook.apiRetirements) {
      if (new RegExp(rule.regex).test(text)) apis.push({ ...rule, file: relative(dir, path) });
    }
  }
  return { models: [...found.values()], apis };
}

function runScan(dir, opts) {
  const { models, apis } = scan(dir);
  const within = Number(opts["fail-within"] ?? -Infinity);
  const soon = models.filter((m) => m.price.retires && daysUntil(m.price.retires) <= within);
  if (soon.length || apis.some((api) => daysUntil(api.date) <= within)) process.exitCode = 1;
  if (opts.json) return console.log(JSON.stringify({ models: models.map((m) => ({ model: m.price.key, retires: m.price.retires ?? null, locations: m.locations })), apis }, null, 2));
  if (!models.length && !apis.length) return console.log("No known model IDs found.");
  const rows = models.map(({ price, locations }) => [
    price.key,
    `${usd(price.rates.standard.in)} / ${usd(price.rates.standard.out)}`,
    usd(priceCall(price, DEFAULT_CALL) * 1000),
    price.retires ? `${price.retires} (${daysUntil(price.retires)}d)` : "—",
    cheaper(price) ?? "—",
    locations.length,
  ]);
  console.log(table(rows, ["model", "per 1M in / out", "per 1K calls*", "retires", "cheaper option", "uses"]));
  console.log("\n* 2,000 input + 500 output tokens per call. Exact costs per customer: https://veqen-app.com/docs");
  for (const api of apis) console.log(`! ${api.name} in ${api.file}: retires ${api.date}. Move to ${api.replacement}.`);
}

function changedModels(base) {
  // Reviewed repositories may define external diff/textconv programs. Never run
  // them in a process that can carry a Veqen API key or a GitHub comment token.
  const commit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], { encoding: "utf8" }).trim();
  const diff = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--unified=0", `${commit}...HEAD`, "--"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const changes = [];
  let file = "";
  let removed = [];
  let paired = 0; // models on removed lines of this hunk, matched in order with models on added lines
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    if (line.startsWith("@@")) [removed, paired] = [[], 0];
    const sign = line[0];
    if ((sign !== "+" && sign !== "-") || line.startsWith("+++") || line.startsWith("---")) continue;
    const models = [...line.matchAll(LITERAL)].map((m) => knownModel(m[1])).filter(Boolean);
    if (sign === "-") removed.push(...models);
    else for (const to of models) changes.push({ file, from: removed[paired++] ?? null, to });
  }
  return changes.filter((c) => c.from?.key !== c.to.key);
}

/** Last 30 days of calls per model, or a note saying why there are none (prices per call are used instead). */
async function productionVolumes() {
  const key = process.env.VEQEN_API_KEY;
  if (!key) return { note: "_Add `VEQEN_API_KEY` to estimate the impact at your production volume._" };
  const endpoint = (process.env.VEQEN_ENDPOINT ?? "https://veqen-app.com").replace(/\/$/, "");
  try {
    const response = await fetch(`${endpoint}/v1/usage/models?days=30`, { headers: { Authorization: `Bearer ${key}`, "User-Agent": process.env.GITHUB_ACTIONS ? "veqen-action/1.0" : "veqen-cli/1.0" }, signal: AbortSignal.timeout(15_000) });
    if (response.ok) return { volumes: new Map((await response.json()).models.map((m) => [`${m.provider}/${m.model}`, m])) };
    const reason = response.status === 402 ? "production volumes need a paid plan" : `the Veqen API answered HTTP ${response.status}`;
    return { note: `_Prices per call only: ${reason}._` };
  } catch (error) {
    return { note: `_Prices per call only: couldn't reach Veqen (${error.message})._` };
  }
}

async function runDiff(base, opts) {
  const changes = changedModels(base);
  const { volumes, note } = await productionVolumes();
  let total = 0;
  const rows = changes.map(({ file, from, to }) => {
    const v = from && volumes?.get(from.key);
    const call = v ? { inputTokens: v.input_tokens / v.calls, outputTokens: v.output_tokens / v.calls, cacheReadTokens: v.cache_read_tokens / v.calls } : DEFAULT_CALL;
    const before = from ? priceCall(from, call) : 0;
    const after = priceCall(to, call);
    const monthly = v ? (after - before) * v.calls : null;
    total += monthly ?? 0;
    return [file, from?.key ?? "(new)", to.key, usd(before * 1000), usd(after * 1000), monthly == null ? "—" : `${monthly >= 0 ? "+" : "−"}${usd(Math.abs(monthly))}`];
  });
  const headers = ["file", "from", "to", "per 1K calls before", "after", "monthly impact"];
  if (opts.format === "json") return console.log(JSON.stringify({ changes: rows, monthly_delta_usd: volumes ? total : null }));
  if (!rows.length) return console.log(opts.format === "markdown" ? "<!-- veqen-cost-review -->\nNo model changes in this pull request." : "No model changes.");
  if (opts.format === "markdown") {
    const md = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`)];
    const summary = volumes ? `**Estimated monthly impact at last 30 days' volume: ${total >= 0 ? "+" : "−"}${usd(Math.abs(total))}**` : note;
    return console.log(["<!-- veqen-cost-review -->", "### Veqen cost review", "", ...md, "", summary].join("\n"));
  }
  console.log(table(rows, headers));
}

async function runAudit(opts) {
  const provider = opts.provider ?? (process.env.ANTHROPIC_ADMIN_KEY ? "anthropic" : "openai");
  const key = provider === "anthropic" ? process.env.ANTHROPIC_ADMIN_KEY : process.env.OPENAI_ADMIN_KEY;
  if (!key) throw new Error("Set OPENAI_ADMIN_KEY or ANTHROPIC_ADMIN_KEY (an admin key; it never leaves this machine).");
  const start = new Date(Date.now() - 30 * 86_400_000);
  const totals = new Map();
  let page = null;
  do {
    const url = provider === "anthropic"
      ? `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start.toISOString().slice(0, 10)}T00:00:00Z&group_by[]=description&limit=31${page ? `&page=${page}` : ""}`
      : `https://api.openai.com/v1/organization/costs?start_time=${Math.floor(start / 1000)}&bucket_width=1d&group_by=line_item&limit=31${page ? `&page=${page}` : ""}`;
    const headers = provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` };
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}: ${await response.text()}`);
    const body = await response.json();
    for (const bucket of body.data) {
      for (const r of bucket.results) {
        const model = provider === "anthropic" ? r.model ?? r.description ?? "other" : (r.line_item ?? "other").split(",")[0];
        const amount = provider === "anthropic" ? Number(r.amount) / 100 : Number(r.amount?.value ?? 0);
        totals.set(model, (totals.get(model) ?? 0) + amount);
      }
    }
    page = body.has_more ? body.next_page : null;
  } while (page);
  const rows = [...totals].sort((a, b) => b[1] - a[1]).map(([model, amount]) => {
    const price = lookup(model, provider);
    return [model, usd(amount), price?.retires ? `${price.retires} (${daysUntil(price.retires)}d)` : "—", price ? cheaper(price) ?? "—" : "—"];
  });
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  console.log(table(rows, ["model", "last 30 days", "retires", "cheaper option"]));
  console.log(`\nTotal over the last 30 days: ${usd(sum)}. See it per customer and feature: https://veqen-app.com`);
}

function runReport(file) {
  if (!existsSync(file)) throw new Error(`No ledger at ${file}. Call veqen.init({ ledgerFile }) or set VEQEN_LEDGER_FILE.`);
  const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const dimension of ["customer", "feature", "model"]) {
    const sums = new Map();
    for (const e of events) {
      const k = e[dimension] ?? "(untagged)";
      const s = sums.get(k) ?? { calls: 0, cost: 0 };
      s.calls += 1;
      s.cost += e.cost_usd ?? 0;
      sums.set(k, s);
    }
    const rows = [...sums].sort((a, b) => b[1].cost - a[1].cost).slice(0, 15).map(([k, s]) => [k, s.calls, usd(s.cost)]);
    console.log(`\n${table(rows, [dimension, "calls", "cost"])}`);
  }
}

function runInit(dir) {
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  const node = read("package.json");
  const python = read("requirements.txt") + read("pyproject.toml");
  const lines = [];
  if (node) {
    lines.push("npm install @veqen/sdk", "");
    if (/"ai"\s*:/.test(node)) lines.push('import { wrapLanguageModel } from "ai";', 'import { veqen } from "@veqen/sdk/ai-sdk";', 'const model = wrapLanguageModel({ model: openai("gpt-4o-mini"), middleware: veqen({ feature: "chat" }) });', "");
    if (/"(openai|@anthropic-ai\/sdk|@google\/genai)"/.test(node)) lines.push('import { wrap, withTags } from "@veqen/sdk";', "const client = wrap(new OpenAI(), { feature: \"chat\" });", 'await withTags({ customer: org.id }, () => client.chat.completions.create({ ... }));', "");
  }
  if (python) {
    const client = /anthropic/i.test(python) && !/\bopenai\b/i.test(python) ? "Anthropic()" : /google-genai/i.test(python) && !/\bopenai\b/i.test(python) ? "genai.Client()" : "OpenAI()";
    lines.push(/langchain/i.test(python) ? "pip install veqen[langchain]" : "pip install veqen", "", "import veqen",
      `client = veqen.wrap(${client}, feature="chat")`, "with veqen.tags(customer=org_id):", "    ...  # every call through the client inside the block is priced and tagged", "");
    if (/litellm/i.test(python)) lines.push("from veqen.integrations.litellm import callback", "litellm.success_callback = [callback]", "");
    if (/langchain/i.test(python)) lines.push("from veqen.integrations.langchain import VeqenCallbackHandler", 'chain.invoke(inputs, config={"callbacks": [VeqenCallbackHandler(feature="chat")]})', "");
    if (/openai-agents/i.test(python)) lines.push("from agents import add_trace_processor", "from veqen.integrations.openai_agents import VeqenTracingProcessor", 'add_trace_processor(VeqenTracingProcessor(feature="agent"))', "");
  }
  if (!lines.length) lines.push("No package.json, requirements.txt or pyproject.toml here. Docs: https://veqen-app.com/docs");
  lines.push("Set VEQEN_API_KEY (https://veqen-app.com/app/settings/keys) to see costs per customer in your dashboard.");
  console.log(lines.join("\n"));
}

// Coding-tool exports, read by the column names Veqen's own import reads them by (CSV_WHO and CSV_USD in veqen_cloud/coding.py)
const COLUMNS = { who: ["useremail", "email", "user", "userid", "login", "username"], usd: ["costusd", "totalcostusd", "netamount", "usd", "cost", "amount", "spend"],
  email: ["useremail", "email"], team: ["team"] };
const MAX_BYTES = 20_000_000; // as the server's import

function parseCsv(text, path) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"' && !field) quoted = true; // a quote inside a field is the quote itself, as the server's reader has it
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (quoted) throw new Error(`${path} has a quote that's never closed.`);
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

function readCsv(path, who, wanted, needs) { // { person, value } rows: the first non-empty `who` column, and the first `wanted` one
  if (statSync(path).size > MAX_BYTES) throw new Error(`${path} is over 20 MB; split it by month.`);
  const [header = [], ...rows] = parseCsv(readFileSync(path, "utf8").replace(/^﻿/, ""), path);
  const names = header.map((h) => h.toLowerCase().replace(/[^a-z]/g, "")), find = (options) => options.map((o) => names.indexOf(o)).filter((i) => i >= 0);
  const people = find(who), [value] = find(wanted);
  if (!people.length || value === undefined) throw new Error(`${path} needs ${needs}.`);
  return rows.map((r) => ({ person: (people.map((i) => (r[i] ?? "").trim()).find(Boolean) ?? "").toLowerCase(), value: (r[value] ?? "").trim() }))
    .filter((r) => r.person);
}

function runCodingBill(args, opts) {
  if (!args.length) throw new Error("Pass one export per tool, like cursor.csv copilot.csv claude-code.csv, or name the tool: cursor=usage.csv.");
  const teams = new Map(opts.teams ? readCsv(opts.teams, COLUMNS.email, COLUMNS.team, "an email column and a team column").map((r) => [r.person, r.value]) : []);
  const tools = [], people = new Map();
  const amount = (text, path) => { // "($5.00)" is -5; a cost that isn't a number stops the bill, as the server's import does
    const value = Number(text.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
    if (!Number.isFinite(value)) throw new Error(`${path} has a cost that isn't a number: ${text}`);
    return value;
  };
  for (const arg of args) { // cursor.csv is Cursor's; cursor=usage.csv names the tool; files for the same tool add up
    const named = !existsSync(arg) && /^([\w-]+)=(.+)$/s.exec(arg), [tool, path] = named ? [named[1], named[2]] : [basename(arg).replace(/\.[^.]+$/, ""), arg];
    if (!tools.includes(tool)) tools.push(tool);
    for (const { person, value } of readCsv(path, COLUMNS.who, COLUMNS.usd,
      "a user or email column and a cost column (an export in credits needs the price per credit, which the dashboard's contracts hold)")) {
      const costs = people.get(person) ?? {};
      costs[tool] = (costs[tool] ?? 0) + amount(value, path);
      people.set(person, costs);
    }
  }
  const total = (costs) => tools.reduce((sum, tool) => sum + (costs[tool] ?? 0), 0);
  const byTeam = new Map();
  for (const [person, costs] of people) {
    const name = teams.get(person) ?? "No team", team = byTeam.get(name) ?? { engineers: 0 };
    byTeam.set(name, team);
    team.engineers += 1;
    for (const tool of tools) team[tool] = (team[tool] ?? 0) + (costs[tool] ?? 0);
  }
  const rank = (map) => [...map].sort((a, b) => total(b[1]) - total(a[1]));
  console.log(table(rank(byTeam).map(([team, t]) => [team, t.engineers, ...tools.map((tool) => usd(t[tool])), usd(total(t))]), ["team", "engineers", ...tools, "total"]));
  console.log(`\n${table(rank(people).slice(0, 10).map(([person, c]) => [person, teams.get(person) ?? "—", usd(total(c))]), ["costliest engineers", "team", "total"])}`);
  console.log(`\n${people.size} engineers and ${usd([...people.values()].reduce((sum, c) => sum + total(c), 0))} in all, read on this machine with nothing uploaded.`
    + "\nEveryone's work and coding agent bill at your contract prices, with limits in each tool: https://veqen-app.com/work-agents");
}

const HELP = `veqen — cost monitoring and protection for AI

  veqen init                     How to add Veqen to this project
  veqen scan [dir] [--json] [--fail-within DAYS]
                                 Model IDs in your code: prices, retirement dates, cheaper options
  veqen diff [base-ref] [--format text|markdown|json]
                                 Cost impact of model changes (uses production volume with VEQEN_API_KEY)
  veqen audit [--provider openai|anthropic]
                                 Last 30 days of provider spend from an admin key, locally
  veqen report [ledger-file]     Costs by customer, feature and model from a local ledger
  veqen coding-bill <export.csv>... [--teams teams.csv]
                                 Each team's and engineer's coding-agent bill from your tools' exports, locally
`;

export async function main(argv = process.argv.slice(2)) {
  const options = { json: { type: "boolean" }, format: { type: "string" }, provider: { type: "string" }, "fail-within": { type: "string" }, teams: { type: "string" },
    help: { type: "boolean", short: "h" } };
  try {
    const { positionals, values } = parseArgs({ args: argv, options, allowPositionals: true });
    const [command, arg] = values.help ? [] : positionals;
    if (command === "init") runInit(arg ?? ".");
    else if (command === "scan") runScan(arg ?? ".", values);
    else if (command === "diff") await runDiff(arg ?? "origin/main", values);
    else if (command === "audit") await runAudit(values);
    else if (command === "report") runReport(arg ?? process.env.VEQEN_LEDGER_FILE ?? ".veqen/ledger.jsonl");
    else if (command === "coding-bill") runCodingBill(positionals.slice(1), values);
    else console.log(HELP);
  } catch (error) {
    console.error(`veqen: ${error.message}`);
    process.exitCode = 1;
  }
}
