# Veqen Pricing plugin

A portable plugin package for the public, unauthenticated `https://veqen-app.com/mcp/prices` endpoint. It exposes exactly four read-only tools: model lookup, model listing, model comparison and workload simulation. It cannot access organization spend or change a ledger.

`plugin.json` supplies directory copy, icons, three starter prompts and five positive / three negative review cases. `mcp.json` declares the public server with no authentication. Zip those two files and `assets/` at the archive root to prepare an upload. Do not include this README in the review archive.

As of 2026-10-24 UTC, direct live MCP checks passed all six tested calls, including cached-input accounting and an unknown-model error. The [captured tool walkthrough](https://github.com/Keyveve/veqen-sdks/releases/tag/pricing-plugin-v1.5.0) demonstrates those calls using a local MCP client. It does not replace end-to-end host testing. Version 1.5.1 corrects only the review examples: the three negative prompts concern unavailable private spend, unsupported mutations and an educational request unrelated to pricing; the unknown-model check is a separate error-handling case. Runtime tools are unchanged.

On October 26, 2026, the owner submitted version 2.0.0 after reviewing its declarations. OpenAI business verification is approved, MCP is configured, and the directory shows **In review**. Submission is not directory approval or publication.

Version 2.0.0 updates the positioning to cost monitoring and protection for AI; the public endpoint still exposes only four read-only pricing tools.

The root repository plugin is the separate authenticated Veqen integration for recorded spend and protection incidents. Do not swap its credentials or write-capable endpoint into this public pricing package.

[Connection documentation](https://veqen-app.com/docs/mcp) · [Pricing methodology](https://veqen-app.com/docs/price-book)
