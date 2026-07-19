# Learning Build 实施计划（中文审阅版）

日期：2026-07-18

英文开发基线：`docs/superpowers/plans/2026-07-18-learning-build-implementation-plan.md`

设计来源：`docs/superpowers/specs/2026-07-06-vc-desktop-agent-design.md`

> 本文仅供中文审阅。开发、验收和后续变更以英文实施计划与英文设计规范为准；如有歧义，以英文文档为准。

前置条件：Foundation 和 Dogfood Build 已完成至提交 `49f743d`。

## 目标

为唯一用户闭合第一条持久个人学习回路：保存去项目化、可跨项目复用的投资学习；按需召回；通过显式两阶段 Investment Reflection 审视 Project 或 Unscoped 判断；通过 Dream 整理普通候选；保留认知演化；并在不静默改变含义的前提下备份或迁移这些认知资产。

本计划只覆盖 Learning Build。Office Skills、OCR 恢复、MCP、Skill Import、Skill Creator、任意 Extension 准入、Extension Audit、Sub-Agent Run、更广泛的执行并发、分发和多用户能力均不在范围内。

## 已确认产品方向

- Investment Reflection 是第一个用户可见的学习工作流；Dream 随后实现，并复用同一套 Memory Evolution 和 patch commit 路径。
- Project Reflection 可以只用宽泛目标“针对这个 Project 进行 Reflection”启动；更具体的问题和 Material 范围均为可选。
- 宽泛启动只提供有边界的 Reflection Project Brief，并通过 Progressive Material Disclosure 按需读取，绝不预加载整个 Project。
- Independent Evidence Pass 不接收 Project Memory 或 Long-term Memory。
- Independent Assessment 形成后，Memory-Aware Reflection Pass 才自主查询相关 Memory。
- Memory 相关性既可以来自 Local Memory Provenance 的直接关系，也可以根据项目上下文、行业、融资阶段、风险、尽调问题、反方观点和不确定性推断。
- 仅仅启动 Reflection 不会召回 `explicit-only` Long-term Memory。
- 默认使用 Investment Reflection；只有用户提到后续证据、项目进展、实际结果或过去判断是否成立时，才使用 Investment Retrospective 框架。
- 普通 Long-term Memory recall 必须去项目化；来源 Project 和证据下钻只在本地向用户提供。

## 规划规则

- 每个切片都要形成桌面端可见路径，并覆盖持久化、失败行为、迁移和测试。
- 在写入新的持久认知数据之前先建立迁移安全机制。
- 用户可编辑的 Memory 和认知历史以 Markdown 为权威；SQLite 和 JSON 索引只保存可重建或运营状态。
- Reflection 和 Dream 共用一套 Memory Evolution 与原子 patch apply 路径。
- 不建设通用 workflow engine、multi-agent runtime、event-sourcing framework、embedding service 或 vector database。
- 先实现 Reflection 所需的状态编排；只有 Dream 出现第二个真实用例时才抽取共享的 resumable-workflow 模块。
- Standard 和 Full Access 均保留 Cognitive Review Gate。工作流启动、恢复和 Memory 写入始终需要用户显式操作。
- 不增加每 Turn 的分类模型调用。召回和候选发现使用当前阶段模型推理加确定性本地检索。
- Provider Failure 不得触发自动重试、Profile fallback、Provider 切换、阶段跳过或 Memory 写入。
- 英文设计规范、词汇表和 ADR 是行为权威；本计划只安排实施顺序。

## 复用现有基础

| 现有路径 | Learning Build 用途 |
| --- | --- |
| Host-owned Thread Trajectory 与恢复 | Reflection 对话、Dream eligibility、来源引用和中断审计 |
| Project Identity | Local Memory Provenance 和 Project 隔离的 Dream extraction |
| Project Memory Markdown 与 parser | Project 定向 Dream patch；只复用 parser 约定，不把它当作全局 Memory |
| `memory_recall` source contract | 接入真实 `long_term_memory` adapter，不修改 Pi session orchestration |
| Memory Candidate Store | Dream 捕获输入；扩展 disposition 和来源元数据，不改写旧 capture event |
| Progressive Material Disclosure | Independent Evidence Pass 和有边界的 Evidence Drilldown |
| System Prompt Revision | Reflection 和 Dream 的冻结 Workflow Prompt Snapshot |
| Capability Registry 与 Host Gateway | Protected workflow 支持和显式 Memory patch commit |
| Model Profile | Task Model Assignment 和工作流启动时 Profile override |
| Runtime resource snapshot | 添加阶段专用 instructions，不扩大 Minimal VC System Prompt |
| Environment Doctor 与本地 telemetry | 检查工作流配置、存储、token、latency、coverage 和 failure |

## 持久化领域边界

默认用户级认知目录：

```text
<app-data>/memory/long-term/
  long-term-memory.md
  long-term-memory-condensation-archive.md
  cognitive-evolution-history.md
```

应用拥有的运营和 provenance 状态：

```text
<app-data>/memory/
  long-term-index/
  local-memory-provenance.jsonl
  candidates.jsonl
  dream/
  reflection/
```

规则：

- Active Memory Markdown 保存稳定的 opaque entry id 和 source-reference id，但不保存来源 Project 名称或路径。
- `local-memory-provenance.jsonl` 将 opaque reference 映射至 Project Identity、workflow run、Judgment Record、Thread、Turn、Output 和允许的 evidence reference。它属于透明本地运营状态，不进入普通 Provider payload，也不进入 Personal Cognition Backup。
- Cognitive Evolution History 保存语义 lineage、旧版本原文、当时理由、Memory Evolution Action 和 opaque source reference，不依赖来源 Project 仍然可用。
- Condensation Archive 只保存 merge 和措辞压缩历史；`Narrow`、`Revise`、`Contradict` 写入 Cognitive Evolution History。
- Derived index 可以删除，并从权威文件和保留的本地 provenance 映射确定性重建。
- Manual edit 始终具有权威性。Host 不根据文本 diff 推断 Memory Evolution Action 或制造 provenance。

## Learning 切片

### L0. 建立安全迁移边界

**前置：** Dogfood Build 完成。

**建设内容：** 用确定性 migration coordinator 替换直接、best-effort 的启动迁移。支持版本检查、有边界 rollback copy、staged transformation、完整验证、原子激活、脱敏失败诊断，以及处理更新版本状态的 Read-only Recovery Mode。

**为什么先做：** Long-term Memory、provenance、Reflection 和 Dream 会形成不能靠后续猜测迁移修复的持久认知。

**验收标准：**

- [ ] 打开当前 schema 的行为保持不变，且不启动 Pi。
- [ ] 受支持的旧 fixture 通过 staged destination 迁移，完整验证后才激活。
- [ ] 激活前注入失败时，旧数据库和文件仍按原字节保持 active，rollback 后可写。
- [ ] Migration 不调用模型、不改写用户 Memory 文本、不推断 provenance、不改变投资含义。
- [ ] Derived index 可以重建，但不能成为权威 migration 输入。
- [ ] 存储 schema 高于当前应用时，在任何 Turn 或状态修改前进入可见 Read-only Recovery Mode。
- [ ] Read-only Recovery Mode 允许检查和受支持的导出，但阻止 Thread、Memory edit、workflow commit、Settings write 和 Project system write。
- [ ] Environment Doctor 显示 active schema、pending migration、rollback availability 和脱敏 failure。

### L1. 建立权威、可召回的 Long-term Memory

**前置：** L0。

**建设内容：** 延迟创建三个 Markdown-first 文件，定义稳定 entry parser，支持应用内外直接编辑，重建确定性中英文 index，并用真实 bounded card-then-expand retrieval 替换 `long_term_memory` unavailable 分支。

**验收标准：**

- [ ] 首次启动不创建 Long-term Memory；首次打开 Settings Memory view 时才延迟创建最小 active file。
- [ ] Settings 显示全局位置、打开目录、refresh/re-index、文件摘要、warning 和最近更新时间。
- [ ] Active entry 具有稳定 id、version、current status、title、tags、applicability、maturity、Recall policy、conflict state、content 和 opaque source reference。
- [ ] Parser 保留 malformed content，只索引安全 entry，并在不调用 LLM repair 的情况下显示 warning。
- [ ] 外部编辑改变权威版本并重建 index，不启动 Pi。
- [ ] Automatic Judgment Recall 只检索与 judgment-heavy work 相关的 `automatic` entry。
- [ ] Explicit Memory Recall 只绕过 task classification，不绕过 relevance、scope、de-identification、conflict、active-version 或 budget。
- [ ] `explicit-only` entry 只在用户显式请求覆盖它们时出现。
- [ ] Unscoped recall 返回去项目化 Long-term Memory，不能访问来源 Project 或任何 Project State。
- [ ] 冲突 view 一起返回，并标记为 Memory 而不是 source evidence。
- [ ] 普通 recall payload 不包含 Project identity、company name、path、未公开指标、交易条款、原始 excerpt 或本地 provenance mapping。

### L2. 在不重写历史的前提下演化 Memory

**前置：** L1。

**建设内容：** 增加 typed Memory Patch，以及 Host-owned compare、preview、stale-check 和 atomic commit 路径，统一处理 `Add`、`Reinforce`、`Narrow`、`Revise`、`Contradict` 和 `Merge / Condense`。

**验收标准：**

- [ ] Patch 记录所有目标文件 base hash；任何 manual 或 workflow write 改变目标后 patch 变 stale。
- [ ] `Add` 创建稳定新 entry；`Reinforce` 增加 provenance 或 maturity，但不复制语义。
- [ ] `Narrow` 和 `Revise` 创建新的 current version，并将旧原文与理由保存到 Cognitive Evolution History。
- [ ] `Contradict` 将实质冲突保存为 Unresolved Memory Conflict。
- [ ] `Merge / Condense` 将删除的冗余内容移入 Condensation Archive，不伪造 cognitive evolution。
- [ ] Recency、重复次数、置信措辞或模型偏好不能将 `Contradict` 自动变成 `Revise`。
- [ ] Commit 前显示最终 Markdown 和 lineage diff；Full Access 也必须确认。
- [ ] Active Memory、history、archive、provenance 和 index 要么全部激活，要么全部不激活。
- [ ] Manual edit/delete 不推断 evolution、archive、provenance 或 history。
- [ ] Archive retention 支持 30、90、180、365 天或永久；默认不自动删除，且永不包含 Cognitive Evolution History。
- [ ] Source drilldown 只在来源 Project 内、遵守 Provider Authorization 时可用；缺失来源显示 unavailable。

### L3. 运行宽泛启动的 Project Independent Evidence Pass

**前置：** L0 和现有 Dogfood material/context/output path。

**建设内容：** 增加显式 `Start Reflection`、可选 focus、确定性 Reflection Project Brief、Workflow Prompt Snapshot、Reflection stage instructions、Task Model Assignment、launch-time Profile override，以及不读取 Memory 的隔离 Independent Evidence Pass。

**验收标准：**

- [ ] Reflection 只从用户显式操作启动，并创建专用 Investment Reflection Thread 和 run record。
- [ ] 默认目标检查当前 view、assumption、risk、counterargument 和可能适用的 prior learning；focus 和 Material selection 可选。
- [ ] 用户提到后续结果或过去判断是否成立时，UI 明确使用 Investment Retrospective framing。
- [ ] Launch 冻结 scope、Project Identity、objective、Brief version、Workflow Prompt Snapshot 和有效 Evidence Profile。
- [ ] Brief 只包含有边界的基础 Context field、Material card、record 或 Output reference，排除 Memory、prior conclusion、path 和 Material body。
- [ ] Independent Evidence Pass 不接收 Project Memory、Long-term Memory、Memory index result 或 Local Memory Provenance。
- [ ] 模型按需扩展 evidence，并输出有边界的 Independent Assessment。
- [ ] 缺少 assignment 或 Profile 时 run 保持本地可见、可 retry，不启动 Pi，也不选择 fallback。
- [ ] Provider Failure 保留 brief 和 run state，显示脱敏信息，只允许手动 retry 或调整 Profile。
- [ ] 重启只显示 run 和已完成 Assessment，不启动 Pi；未完成模型工作只允许显式恢复。

### L4. 完成 Memory-Aware Reflection 并确认结果

**前置：** L1、L2、L3。

**建设内容：** 从 Independent Assessment 创建独立 Memory-Aware Reflection context，自主检索相关 Memory，支持 bounded Evidence Drilldown，开展 critical dialogue，并通过共享 Memory Patch 路径准备可选 Judgment Record 和 Long-term Learning Proposal；同一机制扩展至 Unscoped scope。

**验收标准：**

- [ ] 第二阶段只接收 bounded Assessment、objective 和允许的 stage instructions，不接收第一阶段原始材料、transcript、full context 或 hidden reasoning。
- [ ] 它根据 Assessment 与 Brief 自主查询 Memory，从 card 开始并选择性展开。
- [ ] same-Project provenance 可以提高候选排序，但不进入 Provider payload，也不使 Memory 具有权威性。
- [ ] 推断相关性使用 applicability、industry、financing stage、risk、diligence question、counterargument 和 uncertainty。
- [ ] 所有 recall 可见且有 budget；没有显式 intent 时继续排除 `explicit-only`。
- [ ] Critical Reflection Stance 区分 evidence、historical User judgment 和 new inference，并在有理由时挑战 Memory。
- [x] Evidence Drilldown 只读取 stable reference 后的 bounded excerpt；不受支持的 handoff claim 必须被标记。
- [ ] 对话可以保持 unresolved 或 discard，不强制生成 Judgment Record 或 Memory patch。
- [ ] Confirmed Judgment Record 保存 view、reasoning、uncertainty、counterargument、evidence reference、decision state 和 source availability。
- [ ] Long-term Learning Proposal 陈述去标识化 applicability、limitation/counterexample、maturity 和 source reference，并与 active Memory 比较。
- [ ] Proposal 必须使用 L2 preview 和 confirmation path，不能绕过 Memory Evolution rule。
- [x] Project Reflection 的 Judgment Record 属于 Project；Unscoped Reflection 写入选定 Output Location，且不访问 Project State。
- [ ] 只有用户明确采纳、修正或确认的 Reflection dialogue 才具备 Dream eligibility；Independent Evidence Pass 永远不具备。
- [ ] Restart recovery 复用未变化的 stage；相关 Memory 或 evidence 改变后 proposal 变 stale。

### L5. 在没有隐藏模型工作的情况下创建 Dream Batch

**前置：** L0、L1、retained trajectory 和 Memory Candidate。

**建设内容：** 增加 model-free Dream Due Check、Pending Dream Reminder、manual launch、单一 frozen Dream Cutoff、Dream Carryover、eligible trajectory selection、source-deletion cascade、Workflow Prompt Snapshot、Dream Task Model Assignment 和 resumable run state。

**验收标准：**

- [ ] 默认七天 Due Check 只读 scheduling metadata，不创建 batch、不读 trajectory content、不启动 Worker、不调用 Provider。
- [ ] Manual launch 或批准 due proposal 只创建一个 batch，并将 cutoff 冻结为最新 eligible user-facing session 的完成时间。
- [ ] Cutoff 之后的新 session 属于下一个 batch，不使当前 result stale。
- [ ] Eligible trajectory 包含普通 Project/Unscoped 对话和 Memory-Aware Reflection dialogue，排除 Dream、Independent Evidence Pass、internal work、pure tool 和未被用户采纳的 assistant output。
- [ ] Captured/recovered candidate 保存可归属的 Thread、Turn、timestamp、scope、source kind 和 bounded reference。
- [ ] 已删除 trajectory 不可扫描，并按设计从 pending/archive candidate 清除内容；archive 不等于删除。
- [ ] Keep Pending、skip、failure 和其他 unresolved input 在 cutoff 前也必须变为显式 Carryover。
- [ ] Resumable run 或 Carryover 立即产生 non-blocking reminder，但不启动模型或自动建 batch。
- [ ] Resume/Discard 解决现有 run 前，不允许创建新的 periodic batch。
- [ ] Full Access 下 launch/resume 仍需显式操作，并冻结 Dream prompt 与 Profile assignment。

### L6. 隔离提取并审阅 Dream Scope

**前置：** L5 和 Project Memory。

**建设内容：** 每个 Project 运行一个隔离 Project Dream Extraction Pass；每个 Unscoped Thread 单独运行 extraction；渐进恢复遗漏信号；产生有边界、去标识化 summary；持久化各 stage；支持按 scope review、retry、skip 和 Keep Pending。

**验收标准：**

- [ ] Project extraction 只看到该 Project 的 candidate、相关 Project Memory 和 bounded eligible trajectory excerpt。
- [ ] Unscoped extraction 只看到一个 Unscoped Thread，没有 Project Memory destination，也不能推断 Project association。
- [ ] Recovered candidate 必须有可归属 User signal 或 confirmed Judgment Record；materials、web、OCR、tool 和普通 assistant text 不能成为 personal Memory。
- [ ] 每个 result 包含 source reference、uncertainty、candidate origin、proposed destination 和 bounded summary，不包含 raw trajectory 或 full reasoning。
- [ ] Project summary 离开 scope-local review 前必须去标识化，并只携带 opaque reference。
- [ ] 用户可以 approve、retry、skip、Keep Pending，无需手动编辑 summary。
- [ ] Failed scope 保持 Pending，显示 sanitized Provider Failure，不自动 retry、fallback 或排除。
- [ ] 每个 scope 成功或被显式 skip 前，Global synthesis 保持 blocked。
- [ ] 显式 skip 产生可见 Partial Dream Coverage，并为缺失 scope 保留 Carryover。
- [ ] Restart 保留 completed scope 和 decision；只有 stale scope 在显式 resume 后重跑。

### L7. 全局综合 Dream 并提交经审阅的 Memory Patch

**前置：** L2、L6。

**建设内容：** 在 approved de-identified summary、相关 Long-term Memory card 和 opaque reference 上运行隔离 Global Dream Synthesis；分类 destination 和 Memory Evolution relationship；预览 Project/Long-term Markdown patch；通过共享 atomic Memory path 提交。

**验收标准：**

- [ ] Global synthesis 不接收 Project name/path、不必要 deal fact、combined raw trajectory 或 cross-Project source excerpt。
- [ ] Proposed Long-term Memory 的最大颗粒度为行业、融资阶段或可复用投资情境。
- [ ] Proposal 区分 Project Memory、Long-term Memory、Keep Pending、Discard、Merge / Condense。
- [ ] 只有明确来自一个 Project 的 proposal 才能写 Project Memory，并写回原 Project。
- [ ] 每个 Long-term proposal 与 active Memory 比较，并使用 L2 evolution semantics。
- [ ] Frequency 和 confidence 不得自动替换旧 judgment 或解决 conflict。
- [ ] UI 支持 bulk review，同时保留 per-item destination change 与 uncertainty inspection。
- [ ] Run approval 不授权 write；final Markdown patch preview 与 confirmation 独立。
- [ ] Partial Dream Coverage 在 synthesis、proposal、patch 和 completed batch 中持续可见。
- [ ] Target Memory 变化使 synthesis 或 prepared patch stale，并阻止 commit。
- [ ] 成功 commit 原子更新 Memory、history、archive、provenance、index，归档 resolved candidate，记录 cutoff 并保留 Carryover。

### L8. 备份与恢复 Personal Cognition

**前置：** L2 和稳定 Learning schema。可以在 L4 后与 L5-L7 并行，但 Learning Gate 等待全部切片。

**建设内容：** 增加显式、透明的 Personal Cognition Backup 和 mechanical Restore，包含 versioned manifest、checksum、empty-state restore 和 confirmed whole-domain replacement，不做 semantic merge。

**验收标准：**

- [ ] Backup 包含 Long-term Memory、Cognitive Evolution History、Condensation Archive、System Prompt Revision、Model Profile/task assignment、非 secret setting，以及存在时的 VC Agent Skills Directory。
- [ ] Thread/Sub-Agent trajectory 可选，默认排除。
- [ ] Backup 排除 Project registry/name/id/path/reference、Material、Output、parse、Project Context、Project Memory、artifact state、local provenance mapping、pending candidate、Dream/Reflection run state、cache、log 和 Physical Model Context。
- [ ] Protected Credential 永不导出；恢复的 Profile reference 需要重新配置 credential。
- [ ] Transparent manifest 保存 format/schema version、domain inventory、checksum、creation time 和 security warning，不保存绝对 Project path。
- [ ] Restore 在替换任何 domain 前验证完整 bundle，不调用 LLM、不合并 Memory、不推断 duplicate、不制造 provenance。
- [ ] 非空 personal state 上 restore 必须在两种 Access Mode 下都显式确认 whole-domain replacement。
- [ ] Restore 失败时旧 domain 全部保持 active、unchanged。
- [ ] Semantic lineage 与 opaque reference 保留；被排除的 Project provenance 显示 unavailable。
- [ ] Backup/Restore 均为 Host-only，不启动 Pi。

## Learning 退出切片

### G2. 通过持久学习工作流 Gate

**前置：** L0-L8。

**验收标准：**

- [ ] 一条 Playwright 场景宽泛启动 Project Reflection，完成隔离 evidence assessment，召回相关 Project/Long-term Memory，开展对话，确认 Judgment Record，预览并提交 Memory Evolution Action，重启后从 Unscoped Thread 召回结果。
- [ ] 场景证明普通 recall 不包含 Project identity，但本地 source inspection 能在授权下定位来源 Project。
- [ ] Retrospective fixture 能 revise 或 contradict 旧 judgment，且不删除原始 rationale。
- [ ] Dream E2E 覆盖至少两个 Project 和一个 Unscoped Thread，证明 raw-scope isolation，审阅 summary，处理一个 failed/skipped scope，显示 Partial Dream Coverage，确认 final patch，并保留 Carryover。
- [ ] Restart recovery 保存已完成 Reflection/Dream stage，但在显式 resume 或提交工作前不启动 Pi。
- [ ] Missing Profile、Provider Failure、stale evidence、外部 Memory edit、stopped stage、failed patch commit 和 manual retry 不触发 fallback、重复写入或静默 stage reuse。
- [ ] Migration failure 恢复旧状态；newer state 只读打开；Backup/Restore 不携带 Project metadata 或 credential。
- [ ] Telemetry 显示 stage prompt/tool/context/recall/output reserve、latency、token contribution、coverage 和 failure counter，但无 remote content telemetry。
- [ ] Architecture test 通过 interface 测试 migration、Long-term Memory source、Memory Patch Store、Reflection runner、Dream runner、provenance registry 和 backup adapter，不导入 Integration/Delegation feature code。
- [ ] Office、OCR、MCP、Skills、Extension Audit、任意 Extension 和 Sub-Agent 控件不得表现为可用功能。
- [ ] 唯一用户无需开发者介入即可从普通 VC 工作进入经审阅的持久个人学习。

## 依赖图

```text
Dogfood -> L0 -> L1 -> L2 --------------------+-------> L7 ----+
              |                               |                 |
              +-------> L3 -> L4 -------------+                 +-> G2
              |                   |                              |
              +-------------------+-> L5 -> L6 -----------------+
                                  |                              |
                                  +-------> L8 ------------------+
```

L8 可以在 L4 后开始，但 L5-L7 到来后，Dream run state、pending review queue 和 Local Memory Provenance mapping 仍不得进入 Backup。

## 阶段 Gate

**Learning Build 完成：** L0-L8 和 G2 全部通过。用户可以显式审视当前或历史投资判断，保存经审阅结果，在不同 scope 中召回去标识化个人学习，通过 Dream 整理普通候选，检查 cognitive evolution 和 local provenance，并在没有隐藏模型工作或自动 Memory 变化的情况下备份或迁移持久认知。
