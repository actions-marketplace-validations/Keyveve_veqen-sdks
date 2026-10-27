# Veqen AI price book

Dated model pricing data for developers who need a local lookup table without a tracking SDK. The packages have no runtime dependencies, make no network requests, and require no account or API key.

```bash
pip install veqen-pricebook
npm install @veqen/pricebook
```

Python:

```python
from veqen_pricebook import load

book = load()
print(book["version"], book["schema"])
print(book["models"]["openai/gpt-4o"]["rates"])
```

JavaScript:

```javascript
import book from '@veqen/pricebook';

console.log(book.version, book.schema);
console.log(book.models['openai/gpt-4o'].rates);
```

For a raw file, use the Python package resource `veqen_pricebook/prices.json`, the npm export `@veqen/pricebook/prices.json`, or the [public JSON endpoint](https://veqen-app.com/prices.json). The endpoint follows the deployed book. Installed packages remain pinned until you update them.

## Schema and units

Schema 2 has `version`, `schema`, `providers`, `models` and pricing metadata. Model keys include the hosting provider. Token rates are **USD per million tokens**, not per token. Non-token model rates use the model's declared unit. Preserve cache reads, five-minute and one-hour cache writes, service tiers, batch rules, long-context thresholds and residency multipliers when calculating costs. Missing rates mean unavailable data, not zero cost.

This package supplies data, not a universal `tokens × price` calculator. Use [`veqen`](https://pypi.org/project/veqen/) or [`@veqen/sdk`](https://www.npmjs.com/package/@veqen/sdk) for the calculation engine and usage adapters. Review [the price-book documentation](https://veqen-app.com/docs/price-book), [model sources](https://veqen-app.com/models) and [migration from tokencost](https://veqen-app.com/guides/migrate-from-tokencost).

## Releases and reproducibility

Package version `YYYY.M.D` identifies the bundled snapshot date. Pin the version in a lockfile to reproduce a calculation. The repository's reviewed SDK snapshot is the source for both packages. `python scripts/package_pricebook.py` regenerates their data and metadata without accessing the network. A newly deployed snapshot does not silently change an already installed package.

Provider prices and availability can change. These are list prices and verified billing rules, not your contract, tax treatment or invoice. Reconcile recorded usage against your provider's bill before treating an estimate as an accounting balance.

MIT licensed. Derived LiteLLM data retains Berri AI's copyright and MIT notice in `THIRD_PARTY_NOTICES`. [Veqen](https://veqen-app.com) provides cost monitoring and protection for AI.
