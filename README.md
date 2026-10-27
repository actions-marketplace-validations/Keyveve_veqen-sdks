# Veqen: cost monitoring and protection for AI

See who spent every AI dollar, and stop the ones nobody should have. Veqen brings work and coding agents together with product inference: cost per person, customer and project, key misuse incidents, provider bill checks and the month-end close.

Start with the free Python or JavaScript SDK; both work locally without an account. Connect the optional [Veqen dashboard](https://veqen-app.com) to compare recorded usage with provider bills and investigate unexplained key spend. Shut-off needs separate permission and must be enabled by your organization.

## Veqen 2.0 compatibility

Python SDK 1.4.0 and JavaScript SDK 1.2.0 add key hints to wrapped calls. Only the final four characters of the provider key are sent; matching hints can collide and do not prove who used a key. The JavaScript CLI also combines coding-agent CSV exports into a bill per person and team. SDK and cloud versions are independent. [Release notes](https://veqen-app.com/docs/whats-new).

## Python

```sh
pip install 'veqen>=1,<2'
```

```python
import veqen
from openai import OpenAI

client = veqen.wrap(OpenAI(), feature="support-bot")
with veqen.tags(customer="acme"):
    client.responses.create(model="gpt-5-mini", input="Where is my order?")
```

Python 3.10+, no runtime dependencies. See [Python documentation](python/README.md) for optional integrations.

## JavaScript and TypeScript

```sh
npm install @veqen/sdk@^1
```

```javascript
import OpenAI from "openai";
import { wrap, withTags } from "@veqen/sdk";

const client = wrap(new OpenAI(), { feature: "support-bot" });
await withTags({ customer: "acme" }, () =>
  client.responses.create({ model: "gpt-5-mini", input: "Where is my order?" }));
```

Node.js 20+, ESM, TypeScript declarations, no runtime dependencies. See [JavaScript documentation](js/README.md).

## Free CLI and pull-request reviews

```sh
npx @veqen/sdk@1 scan
npx @veqen/sdk@1 diff origin/main
npx @veqen/sdk@1 audit
npx @veqen/sdk@1 report
npx @veqen/sdk@1 coding-bill cursor.csv copilot.csv claude-code.csv --teams teams.csv
```

Scan model references for prices and retirement dates, compare model changes, import provider usage locally with your admin key, or report on a local ledger. The [cost-review Action](github-action/README.md) adds a pull-request summary and optional retirement checks. It never executes the reviewed application's code. Use `pull_request`, not `pull_request_target`.

## Accuracy, budgets and privacy

Costs use provider-reported usage and the bundled price book, including supported cache, batch, tier and residency rules. Negotiated rates, missing usage and unsupported model variants need explicit prices or reconciliation; calculated costs are not a provider invoice. Derived price data retains its [upstream MIT attribution](pricebook/THIRD_PARTY_NOTICES).

Budgets check recorded spend before a wrapped call. They block subsequent calls once the observed limit is reached; a call already in flight can exceed it. Local budgets are per process and reset on restart. Dashboard budgets are polled, so concurrency, ingestion and polling delays can also cause overshoot. These are not guaranteed spending caps.

No account or network reporting is required for local cost tracking. Set `VEQEN_API_KEY` to send usage metadata and your tags to Veqen. Avoid personal data and secrets in tags. The SDK does not send prompt or response content.

## Agent integration

Try the [live AI cost starter](https://veqen-ai-cost-starter.vercel.app/) and its [Next.js / Vercel AI SDK source](examples/vercel-ai-cost-starter/) to see an AI response alongside its estimated cost. The default demo needs no API keys and makes no inference requests. [Veqen AI Cost Lens on Open VSX](https://open-vsx.org/extension/Keyveve/veqen-cost-lens) adds offline model-price hovers and a local model inventory. Its publisher ownership review is pending; the listing currently displays an unverified-publisher warning. You can also [build and install the VSIX](vscode-extension/).

The [Veqen Pricing plugin package](plugins/veqen-pricing/) exposes only the four public read-only pricing tools. The package is prepared for directory review; this repository does not imply directory approval.

Already using OpenLLMetry? Follow the tested [Collector setup](examples/openllmetry/) to export GenAI usage to Veqen with customer and feature attribution.

Connect to `https://veqen-app.com/mcp` using OAuth or a full-access Veqen API key. Root `plugin.json`, `mcp.json` and [skills](skills/) describe the agent integration. The public `https://veqen-app.com/mcp/prices` server needs no sign-in and offers model prices, comparisons and workload simulation. See [connection instructions](https://veqen-app.com/docs/mcp) and [agent documentation](https://veqen-app.com/docs/agents).

## Migrating from 0.x

Version 1 is a different product and a breaking API change. The old `Veqen().signup(...)` risk-check client and 0.x versions of the `@veqen/sdk` JavaScript package are not compatible with these APIs. Remove those integrations before upgrading; the retired signup-check endpoints must not be used for new implementations. The historical `data/` blocklist remains for attribution and compatibility, but is no longer refreshed here.

## Development

```sh
python -m pip install -e 'python[test]'
python -m pytest python/tests
cd js
npm ci --ignore-scripts
npm test
```

Code: [MIT](LICENSE). Historical dataset: [CC0](data/README.md). Support: [support@veqen-app.com](mailto:support@veqen-app.com).
