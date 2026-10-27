# Veqen agent plugin

Portable [Agent Plugins 1.0.0](https://agent-plugins.org/) metadata for Veqen, cost monitoring and protection for AI:

- `mcp.json`: the hosted MCP servers. `https://veqen-app.com/mcp` reads your organization's ledger after an OAuth sign-in; `https://veqen-app.com/mcp/prices` is the public price book and needs no sign-in.
- `skills/veqen-costs/SKILL.md`: how an agent adds cost tracking to a codebase and answers cost questions with the tools.

The same files are published at the root of the public [Keyveve/veqen-sdks](https://github.com/Keyveve/veqen-sdks) repository so compatible clients and directories can discover them. They contain no credentials; authentication happens in the client's OAuth flow. Clients without plugin support can add `https://veqen-app.com/mcp` directly. See the [MCP guide](https://veqen-app.com/docs/mcp).

Veqen records model, token counts, price and the tags your code sets. It never receives prompts or responses.
