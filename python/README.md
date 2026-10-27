# veqen

Veqen is cost monitoring and protection for AI. The SDK shows what your AI requests cost and who they were for: a customer, a feature or a project, and tells Veqen which key made each one, so spend nobody on your team made stands out. Start locally without an account, then connect the optional dashboard to see where spending goes and compare it with your provider bills.

```bash
pip install veqen
```

Python 3.10+, no dependencies in the base package, works offline. Optional integrations: `veqen[langchain]`, `veqen[litellm]` `veqen[llamaindex]` and `veqen[haystack]` (Python 3.11+ for Haystack).

```python
import veqen
from openai import OpenAI

client = veqen.wrap(OpenAI(), feature="support-bot")

with veqen.tags(customer="acme", user="u_42"):
    client.responses.create(model="gpt-5-mini", input="Where is my order?")
```

Every call is priced from the usage the provider reports, with the rules providers bill by: cached input, 5-minute and 1-hour cache writes, batch, priority and flex tiers, long-context rates and data residency. Prompts and responses are never read.

- **Wrap** OpenAI (sync and async, streams, Responses, Chat Completions, embeddings, images and audio), Anthropic (messages and streams) and Google GenAI clients. An OpenAI client pointed at Together, Fireworks, Groq, Azure AI Foundry or another compatible host is priced as that host; name your own servers with `veqen.wrap(client, provider="self-hosted")`.
- **Tag** calls with `veqen.tags(customer=..., feature=..., user=..., project=..., run=...)`; tags follow `asyncio` code.
- **Budget**: `veqen.budget(5.00, customer="*")` raises `veqen.BudgetExceeded` before subsequent wrapped calls once recorded spend reaches the limit.
- **Record** anything else: `veqen.record("claude-sonnet-5-5", provider="anthropic", input_tokens=1200, output_tokens=300)`, or by unit for media models: `veqen.record("veo-3.1-generate-001", provider="google", units=8, variant="1080p")`.
- **Price** without recording: `veqen.cost("gpt-4o", 1000, 500)` returns `0.0075`.
- **Integrations**: `veqen.integrations.langchain`, `veqen.integrations.litellm`, `veqen.integrations.openai_agents`, and the [Haystack chat-cost component](https://github.com/Keyveve/veqen-sdks/tree/main/examples/haystack).

In serverless functions, call `veqen.flush()` before returning. Write a local ledger with `veqen.init(ledger_file=".veqen/ledger.jsonl")` and see cost per customer, feature and model with `npx @veqen/sdk report`. Set `VEQEN_API_KEY` to send calls to the [Veqen dashboard](https://veqen-app.com/signup?utm_source=python-sdk&utm_medium=package&utm_campaign=launch-v1-5) for shared budgets, reconciliation with your provider bills, custom and self-hosted prices, margin per customer and month-end journal entries. Free up to $1,000 of tracked AI spend a month.

Docs: https://veqen-app.com/docs/python · Model prices: https://veqen-app.com/models · MIT licensed.

## LiteLLM

Install `pip install 'veqen[litellm]>=1.1.0'`, then register the supported `CustomLogger`:

```python
import litellm
import veqen
from veqen.integrations.litellm_logger import VeqenLogger

veqen.init()  # optional VEQEN_API_KEY for the hosted ledger
litellm.callbacks = [VeqenLogger()]
```

Pass attribution as `metadata={"veqen": {"customer": "acme", "feature": "chat"}}` on a LiteLLM call. The logger copies allowlisted cost metadata, not prompts or responses. It observes completed calls and does not enforce pre-call budgets. Register only one Veqen recording path per request. See the [LiteLLM guide](https://veqen-app.com/docs/litellm) for proxy configuration and the hosted logging endpoint.

Budgets are not guaranteed spending caps. In-flight and concurrent calls can exceed the limit. Local counters are per process and reset on restart; dashboard budgets also depend on ingestion and polling delays.
