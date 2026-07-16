# Use PyMuPDF Before Page-Level PaddleOCR

Amended by ADR-0059, which adds OvisOCR2 after ordinary PaddleOCR for unresolved complex pages.

Accepted and retained: the Personal Build uses pinned PyMuPDF as the single native PDF parser and page renderer, then invokes PaddleOCR only for pages whose encoded text is absent or unreliable. Both stages stay behind one `material_parse` capability, so this improves PDF coverage without adding another model-visible tool, provider selector, daemon, or user-selectable OCR fallback chain. The original two-stage failure behavior is replaced by ADR-0059's OvisOCR2 Complex Page Recovery and best-earlier-result retention. PyMuPDF's AGPL/commercial licensing is acceptable only within the current Personal Build assumption and must be reviewed or replaced before any distributable release.
