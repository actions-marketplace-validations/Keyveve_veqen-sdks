# Veqen AI Cost Lens

See AI model prices as you code. Hover a model name to check its price, or find the models used across your project. Everything runs inside your editor. You do not need an account, and your code is never uploaded.

[Install in VS Code](https://marketplace.visualstudio.com/items?itemName=Keyveve.veqen-cost-lens) or [install from Open VSX](https://open-vsx.org/extension/Keyveve/veqen-cost-lens). Keyveve's Open VSX namespace ownership is verified. Search for **Veqen AI Cost Lens** in your editor's Extensions view, or run `code --install-extension Keyveve.veqen-cost-lens` in a terminal with the VS Code CLI installed.

Hover a quoted model such as `"openai/gpt-4o"` or `"gpt-4o"` in Python, JavaScript, TypeScript, JSON or YAML. The extension shows the bundled price-book date and standard rates. When a bare model name matches several billing hosts, it shows the ambiguity rather than selecting a provider for you.

Run **Veqen: Inventory Model References** from the Command Palette to list recognized references and their locations in the output panel. The scan reads at most 200 supported source files, skips files larger than 500 KB and common dependency/build directories, and reports when it is partial. It does not execute project code or invoke a shell. It can operate in an untrusted or virtual workspace.

## Limits

This is a model-reference inventory, not measured spend or an invoice. Dynamic identifiers, escaped strings and models absent from the snapshot are not recognized. Unknown rates remain unknown. Hovers show standard list rates; cache, batch, long-context, image variants, residency and negotiated pricing can differ. A retirement date is shown only when the book records it. The price book updates when the extension updates; the extension makes no background network requests.

Disable hovers with `veqen.hoverEnabled`. The documentation command opens the public Veqen documentation in your browser only when selected. It includes a fixed channel label and sends no source code, file paths or workspace identity.

## Build from source

See the [contributor guide](https://github.com/Keyveve/veqen-sdks/blob/main/vscode-extension/CONTRIBUTING.md) for local builds, packaging checks and dependency maintenance. The packaged price book is a reviewed snapshot; the extension never downloads it during editor use.

[Pricing rules](https://veqen-app.com/docs/price-book) · [SDK and CLI](https://veqen-app.com/docs/cli) · [Report an issue](https://github.com/Keyveve/veqen-sdks/issues)

MIT licensed. See LICENSE and THIRD_PARTY_NOTICES in the package.
