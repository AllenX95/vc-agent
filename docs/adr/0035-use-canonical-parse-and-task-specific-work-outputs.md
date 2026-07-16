# Use Canonical Parse And Task-Specific Work Outputs

Accepted: the first release keeps a faithful reusable Canonical Parse with stable source references, but does not generate or maintain a persistent file-bound Structured Projection. When a task needs structure, the Agent retrieves bounded Canonical Parse excerpts and creates a source-referenced Work Output such as a claim table, company fact pack, metric table, memo input pack, meeting brief, or diligence list.

This supersedes ADR-0005 and ADR-0006. It avoids a mandatory LLM transformation for each parsed file, fixed schema selection, projection staleness, false precision, and a separate repair lifecycle. The trade-off is that task-specific structure may be regenerated or duplicated until repeated use demonstrates a stable pattern worth codifying through Skill Creator.
