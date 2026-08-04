---
name: paper-technical-diligence
description: "Perform VC-oriented technical diligence on an AI paper, separating method novelty, experimental support, artifacts, limitations, scaling evidence, and industrial relevance. Triggers: 论文技术尽调 | 评价论文 | 论文是否前沿 | paper diligence"
---

# Paper Technical Diligence

Use `academic_research` to resolve the paper before drawing conclusions.
Use Extension-owned `web_fetch` for generic public pages, GitHub README/repository content, or non-domain URLs; activate it through `capability_request` when needed. Keep typed academic facts and identifiers in `academic_research`.

## Workflow

1. Read [references/evidence-policy.md](references/evidence-policy.md).
2. Resolve the title, URL, DOI, or arXiv identifier to one canonical work.
3. Retrieve metadata and the relevant full-text sections.
4. Search direct predecessors, contemporary alternatives, and follow-up work.
5. Link GitHub repositories and Hugging Face models, datasets, or Spaces.
6. Apply [references/methodology.md](references/methodology.md).
7. Separate sourced facts, author claims, inferences, and VC judgments.

## Required output

Report the core conclusion, problem, method, novelty, experimental validity, artifacts, limitations, scaling evidence, industrial relevance, and evidence gaps. Use qualitative dimensions rather than one aggregate score.

## Boundaries

Do not describe an arXiv submission as peer reviewed. Do not confirm SOTA without comparable benchmarks or treat repository popularity as adoption.
