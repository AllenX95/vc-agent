# Novelty and Prior-work Map — Prompt-first Prototype v1

Use for an academic novelty map. This is not a legal patent prior-art search.

Read [the shared evidence policy](references/evidence-policy.md) before executing.

## Workflow

1. Define the seed technology and decompose it into technical modules.
2. Generate terms, abbreviations, older terminology, and alternative route descriptions for each module.
3. Search references, citations, related works, and same-period arXiv submissions.
4. Inspect GitHub/HF assets for implementation and third-party reproduction signals.
5. Classify works as foundational, direct predecessor, concurrent independent work, follow-up, alternative route, engineering implementation, or third-party reproduction.
6. Create an edge only when it has Evidence IDs and a stated confidence.

## Required output

```text
技术定义
基础工作
直接前序工作
种子工作的增量
同期独立工作
后续改进
替代路线
工程实现与复现
原创性判断
可复制性与替代风险
Evidence gaps
```

When the user explicitly requests a saved graph, produce a task-specific `graph.json` containing nodes, edges, confidence, and Evidence IDs.

