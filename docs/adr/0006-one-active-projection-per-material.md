---
status: superseded by ADR-0035
---

# Use One Active Projection Per Material

Accepted: each parsed material has one active Structured Projection, bound to that file's Canonical Parse. The Projection Category is selected when the projection is first created and then remains fixed; later improvements append Projection Attributes or repair fields within that same projection instead of changing category or creating another parallel view.

This keeps the material model simple and avoids redundant `views/` for the same source file. Task-specific artifacts such as claim tables, memo input packs, meeting briefs, and diligence question lists remain downstream outputs that can use the file projection as context.
