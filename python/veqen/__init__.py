"""Veqen: cost monitoring and protection for AI.

    import veqen
    from openai import OpenAI

    client = veqen.wrap(OpenAI())
    with veqen.tags(customer="acme", feature="support-bot"):
        reply = client.chat.completions.create(model="gpt-4o-mini", messages=[...])

Every call is priced exactly (caching, batch, tiers) and attributed to the customer and feature that
caused it. Without an API key everything stays local; with VEQEN_API_KEY it reaches your Veqen ledger.
"""

from veqen.client import BudgetExceeded, budget, current_tags, flush, init, record, tags
from veqen.pricing import Price, PriceBook, Usage, cost, lookup, price_book
from veqen.wrap import wrap

__version__ = "1.4.0"
__all__ = [
    "BudgetExceeded",
    "Price",
    "PriceBook",
    "Usage",
    "budget",
    "cost",
    "current_tags",
    "flush",
    "init",
    "lookup",
    "price_book",
    "record",
    "tags",
    "wrap",
]
