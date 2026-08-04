---
name: research-to-company-map
description: "Trace papers and research teams through authors, institutions, GitHub organizations, Hugging Face organizations, models, datasets, and demos to candidate commercialization organizations. Triggers: 论文到公司 | 研究成果产业化 | 学术团队创业 | research to company"
---

# Research To Company Map

Use `academic_research` to build an evidence-backed chain from research to public technical organizations.
Use Extension-owned `web_fetch` for generic public pages and GitHub repository content; activate it through `capability_request` when needed. Keep normalized identities and typed links in `academic_research`.

## Workflow

1. Read [references/evidence-policy.md](references/evidence-policy.md).
2. Resolve seed papers and authors.
3. Link institution, GitHub, and Hugging Face identities using explicit cross-links first.
4. Separate official assets, author-affiliated assets, and third-party reproductions.
5. Rank candidate organizations using the signals in [references/methodology.md](references/methodology.md).
6. Search for disconfirming identity or ownership evidence.

## Required output

List candidate organizations, linked papers, people, public artifacts, evidence chain, confidence, and missing confirmation. Use cautious labels such as candidate commercialization organization or possible association.

## Boundaries

Do not confirm employment, incorporation, financing, commercial adoption, or intellectual-property ownership from these four academic and artifact sources alone.
