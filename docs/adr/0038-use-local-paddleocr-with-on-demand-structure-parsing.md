# Use Local PaddleOCR With On-Demand Structure Parsing

Accepted: the Personal Build uses one local PaddleOCR Configured OCR Capability, running ordinary OCR by default and activating PP-StructureV3 only for pages that need complex layout, table, formula, seal, or image-aware recovery. The runtime and models are pinned and installed only after User confirmation rather than embedded in the main installer, and failure remains visible instead of automatically switching to MinerU, Unlimited-OCR, an external service, or another OCR provider.
