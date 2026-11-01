# Veqen Pricing registry entry

This metadata registers Veqen's existing hosted public price book separately from the authenticated organization server. Connect to `https://veqen-app.com/mcp/prices` without an account to use `get_model_price`, `list_models`, `compare_models` and `simulate_workload`. All four tools are read-only. Prices and simulations are estimates; check provider terms and invoices before making purchasing decisions.

The hosted implementation is part of Veqen Cloud. This repository contains the registry metadata and public client documentation, not the cloud server's source code. The separate `io.github.Keyveve/veqen` listing still uses OAuth for private organization data and authorized changes.

The `Publish public pricing MCP listing` workflow validates the registry schema and checks the anonymous live tool list. Publishing requires an explicit manual run on `main`, the exact version in `server.json`, and the `mcp-pricing` environment (restricted to `main`). It uses short-lived GitHub OIDC identity and a checksum-verified publisher binary.
