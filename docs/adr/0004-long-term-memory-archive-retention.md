---
status: superseded by ADR-0014
---

# Archive Condensed Long-Term Memory With Retention

Accepted: condensed or superseded Long-term Memory entries move to a Long-term Memory archive instead of being immediately deleted. The archive is maintained by Dream and settings, with configurable retention so old archived entries can eventually be cleaned up.

This keeps active Long-term Memory concise without losing reviewability right after condensation. The trade-off is that the product must expose clear retention controls because archive cleanup can delete historical memory entries.
