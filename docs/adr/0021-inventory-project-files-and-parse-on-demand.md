# Inventory Project Files And Parse Content On Demand

Accepted: opening a Project creates a lightweight Material Inventory from file metadata but does not parse every file, invoke OCR or LLMs, or load content into model context. Canonical Parse runs only for selected, attached, task-relevant, or explicitly batched Materials and reuses cached Parsed Material Artifacts through Parse Identity; model disclosure remains separately progressive. This preserves discoverability and low-friction project work while preventing folder-open cost and context growth from scaling with the entire data room.
