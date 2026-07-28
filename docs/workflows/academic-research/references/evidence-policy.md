# Academic Research Evidence Policy

## Evidence classes

1. Original asset: paper text, repository state, README, Model/Dataset/Space Card.
2. Structured index: OpenAlex metadata and graph records.
3. Publisher or author claim: abstract, paper result, README, Card.
4. Inference: a conclusion formed from multiple evidence records.
5. VC judgment: an investment-relevant interpretation that is not presented as a source fact.

Every verifiable factual statement must cite an Evidence ID or source URL returned by `academic_research`. Keep author claims, inference, and VC judgment visibly distinct.

## Status vocabulary

Use only:

```text
已验证
基本支持
部分支持
证据冲突
无法验证
已被反证
```

## Prohibited transformations

- arXiv submission → peer-reviewed or accepted paper.
- Indexed publication → independently verified venue decision.
- README/Card claim → independently reproduced result.
- Repository exists → complete source code.
- Stars/downloads/citations → customers, revenue, adoption, or technical quality.
- Same author name → same person.
- Institution affiliation → IP ownership.
- No search result → proof that the technology does not exist.
- Similar project or organization name → confirmed company relationship.

## Required limitations

The four-source prototype cannot independently verify conference reviews/decisions, employment, company registration, financing, patents, IP ownership, customer adoption, or production deployment. State these gaps when they affect the conclusion.

