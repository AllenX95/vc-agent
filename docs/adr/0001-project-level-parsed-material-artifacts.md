# Store Parsed Material Artifacts At Project Level

Accepted: Parsed material artifacts live under `outputs/parsed/` instead of thread or task output folders. Document parsing produces reusable project assets that are commonly referenced by multiple threads and workflows, while `outputs/work/` remains focused on task-specific analysis, drafts, diffs, and deliverables.

This trades a slightly larger top-level `outputs/` structure for less duplication and clearer cross-thread reuse. Source materials remain in their original project locations; only derived parse artifacts are stored under `outputs/parsed/`.
