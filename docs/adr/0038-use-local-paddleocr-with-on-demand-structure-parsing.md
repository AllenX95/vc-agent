# Use Local PaddleOCR With On-Demand Structure Parsing

Superseded by ADR-0059.

Historical decision: the Personal Build used one local PaddleOCR Configured OCR Capability, running ordinary OCR by default and activating PP-StructureV3 only for pages that needed complex layout, table, formula, seal, or image-aware recovery. The active first-release chain and failure behavior are now defined by ADR-0059.
