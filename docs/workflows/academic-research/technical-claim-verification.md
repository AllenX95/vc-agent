# Technical Claim Verification — Prompt-first Prototype v1

Use for claims such as “global first”, “SOTA”, “top-conference paper”, “complete open-source ecosystem”, “validated at 100B parameters”, or “the team has worked in this field for years”.

Read [the shared evidence policy](references/evidence-policy.md) before executing.

## Workflow

1. Copy the original claim without strengthening it.
2. Decompose it into atomic, independently testable claims.
3. Record a query plan for each atomic claim.
4. Search supporting evidence and actively seek limitations or counterevidence.
5. Check what each evidence record actually supports.
6. Assign one permitted status and state the remaining gap.

## Required output

| Atomic claim | Status | Supporting evidence | Limit/counterevidence | Judgment |
|---|---|---|---|---|

Finish with:

```text
宣传口径是否需要收窄
当前四源覆盖范围
仍需补充的数据源或原始材料
```

Negative search supports only: “在当前四个数据源、查询词和时间范围内，未找到足以支持该表述的证据。”

