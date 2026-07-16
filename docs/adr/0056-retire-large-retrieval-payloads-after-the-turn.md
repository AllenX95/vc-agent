# Retire Large Retrieval Payloads After The Turn

Accepted: complete Material excerpts, recalled Memory bodies, fetched Web or MCP content, parse results, and other large read-tool payloads are model-facing only for the Turn that requested them. Before a later Provider request, vc-agent replaces each retired payload in the Physical Model Context with a compact Context Reference that lets the primary Agent retrieve the authoritative content again when needed.

This transformation does not rewrite Thread Trajectory, authoritative source files, or ordinary User and Assistant messages. Small tool results may remain under one deterministic versioned threshold, while Assistant text that quotes or summarizes a source remains ordinary conversation until Thread Compaction. The policy trades occasional local re-retrieval and possible Provider prefix-cache invalidation near the retired result for bounded long-Thread input cost and less stale source content in future reasoning.
