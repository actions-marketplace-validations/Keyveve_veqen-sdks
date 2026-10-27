# veqen

Veqen is cost monitoring and protection for AI. The SDK shows what your AI requests cost and who they were for: a customer, a feature or a project, and tells Veqen which key made each one, so spend nobody on your team made stands out. Start locally without an account, then connect the optional dashboard to see where spending goes and compare it with your provider bills. Includes the `veqen` CLI.

```bash
npm install @veqen/sdk
```

Node.js 20+, ESM, no dependencies, TypeScript types included.

```ts
import OpenAI from "openai";
import { wrap, withTags } from "@veqen/sdk";

const client = wrap(new OpenAI(), { feature: "support-bot" });

await withTags({ customer: "acme", user: "u_42" }, () =>
  client.responses.create({ model: "gpt-5-mini", input: "Where is my order?" }));
```

Every call is priced from the usage the provider reports, with cached input, cache writes, batch, priority and flex tiers, long-context rates and data residency. Prompts and responses are never read.

- **Wrap** OpenAI, Anthropic and Google GenAI clients, streams and stream helpers included, plus OpenAI embeddings, images and audio. An OpenAI client pointed at Together, Fireworks, Groq, Azure AI Foundry or another compatible host is priced as that host; for your own servers, `wrap(client, { provider: "self-hosted" })`.
- **Record** anything else, by tokens or by unit: `record("google", "veo-3.1-generate-001", { units: 8 }, { variant: "1080p" })`.
- **Vercel AI SDK** middleware: `import { veqen } from "@veqen/sdk/ai-sdk"` and `wrapLanguageModel({ model, middleware: veqen() })`.
- **LangChain.js**: `import { VeqenCallbackHandler } from "@veqen/sdk/langchain"`.
- **Budgets**: `budget(5, { customer: "*" })` throws `BudgetExceeded` before subsequent wrapped calls once recorded spend reaches the limit.
- **Price** without recording: `cost("gpt-4o", { inputTokens: 1000, outputTokens: 500 })`; the price book is `@veqen/sdk/prices`.

## CLI

```bash
npx @veqen/sdk init                  # the setup for this project
npx @veqen/sdk scan                  # models in your code: prices, retirement dates, cheaper options (--json, --fail-within 30)
npx @veqen/sdk diff origin/main      # cost impact of model changes in this branch (--format markdown|json)
npx @veqen/sdk audit                 # last 30 days from your OpenAI or Anthropic admin key, locally
npx @veqen/sdk report                # cost by customer, feature and model from a local ledger (init({ ledgerFile }))
npx @veqen/sdk coding-bill cursor.csv copilot.csv claude-code.csv --teams teams.csv
                                     # each team's and engineer's coding-agent bill from your tools' exports, offline
```

`coding-bill` reads any export with a user or email column and a cost column, naming each tool after its file, or `tool=file.csv`; files for one tool add up. `--teams` takes a CSV with email and team columns. Nothing is uploaded. Calls through the SDK also carry the last four characters of the provider key, so Veqen can tell which key made them and catch spend nobody on your team made.

In serverless functions, `await flush()` before returning. Set `VEQEN_API_KEY` to send calls to the [Veqen dashboard](https://veqen-app.com/signup?utm_source=javascript-sdk&utm_medium=package&utm_campaign=launch-v1-5) for shared budgets, reconciliation with your provider bills, custom and self-hosted prices, margin per customer and month-end journal entries. Free up to $1,000 of tracked AI spend a month.

Docs: https://veqen-app.com/docs/javascript · Model prices: https://veqen-app.com/models · MIT licensed.

Budgets are not guaranteed spending caps. In-flight and concurrent calls can exceed the limit. Local counters are per process and reset on restart; dashboard budgets also depend on ingestion and polling delays.
