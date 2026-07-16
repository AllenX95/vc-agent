---
status: superseded by ADR-0035
---

# Separate Canonical Parse From Structured Context

Accepted: first-layer material parsing is deterministic and produces a Canonical Parse, while the LLM maps that parse into a validated file-bound Structured Projection used as Structured Context for downstream work. The LLM is constrained to preserve source references, mark missing or uncertain fields, and avoid unsupported project facts.

This keeps the reusable parse layer stable and auditable while still letting VC workflows use structured, task-specific context. The trade-off is a more explicit two-step pipeline, but it prevents free-form LLM summaries from becoming the factual parse substrate.
