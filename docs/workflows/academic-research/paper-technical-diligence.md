# Paper Technical Diligence — Prompt-first Prototype v1

Use when the user supplies a paper title, DOI, arXiv/OpenAlex identifier, or asks whether an AI research result is technically strong or commercially relevant.

Read [the shared evidence policy](references/evidence-policy.md) before executing.

## Workflow

1. Resolve the seed work with `academic_research`.
2. Inspect OpenAlex and arXiv metadata; retain version and preprint distinctions.
3. Fetch bounded sections covering the problem, method, experiments, and limitations.
4. Retrieve references, citations, and related work needed to test the claimed novelty.
5. Search and inspect linked GitHub/Hugging Face artifacts.
6. Separate source facts, author claims, inference, and VC judgment.
7. Mark every missing or unavailable evidence class.

## Required output

```text
核心结论
问题与方法
创新增量
实验是否支撑结论
代码、模型、数据与 Demo
局限和 Scaling 证据
产业化价值
对创业项目的意义
未验证事项
Evidence references
```

Do not calculate an overall score. Do not claim SOTA unless benchmark definitions, data split, baselines, resource differences, and evaluation conditions are comparable.

