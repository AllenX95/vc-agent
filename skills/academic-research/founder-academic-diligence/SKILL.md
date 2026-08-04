---
name: founder-academic-diligence
description: "Assess an AI founder or team member's academic identity, representative work, contribution role, research independence, engineering evidence, collaboration network, and fit with the startup direction. Triggers: 创始人学术尽调 | 团队学术能力 | 研究独立性 | founder academic diligence"
---

# Founder Academic Diligence

Use `academic_research` for author, paper, citation, GitHub, and Hugging Face evidence.
Use Extension-owned `web_fetch` for generic public pages and repository content; activate it through `capability_request` when needed. Keep identity links and typed evidence in `academic_research`.

## Workflow

1. Read [references/evidence-policy.md](references/evidence-policy.md).
2. Resolve identity before aggregating publications.
3. Require at least two identity signals among institution, coauthors, topic history, linked accounts, and personal pages.
4. Select representative work by relevance and contribution, not publication count alone.
5. Analyze author position, topic continuity, collaboration patterns, and evidence of independent direction.
6. Inspect linked engineering assets without assuming account ownership proves personal authorship.
7. Apply [references/methodology.md](references/methodology.md).

## Required output

Report identity confidence, representative work, contribution role, research continuity, independence, engineering evidence, collaboration network, startup fit, strengths, and evidence gaps.

## Boundaries

Do not infer personality, leadership, commercial ability, or intellectual-property ownership from academic records.
