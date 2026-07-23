# Integration Build 实施计划（中文审阅版）

日期：2026-07-22

英文基准：`docs/superpowers/plans/2026-07-22-integration-build-implementation-plan.md`

前置条件：Learning Build 已完成至提交 `1dae091`。

> 本文仅供中文审阅。开发、验收和后续变更以英文实施计划与英文设计规范为准；如有歧义，以英文文档为准。

## 目标

在已闭合的日常工作与个人学习回路之上，补齐共享执行底座、隔离 Skills、直接使用用户提供的 Claude Code Office Skills、本地页面恢复、受控 MCP 和经过审阅的 Pi Extension 准入，使当前垂直 Alpha 成为可实际长期使用的 Personal Build，同时不削弱既有 Host、Project、Provider Authorization、Output Intent 和 Cognitive Review 边界。

后续每个 Slice 的可执行规格统一索引于 `docs/superpowers/specs/2026-07-22-integration-slice-spec-index.md`。

本计划覆盖 Integration Build，以及 Office、OCR、MCP 和 Extension 并发任务所必需的最小 Runtime Foundation。显式 Sub-Agent Runs 不在本计划范围内，将在本 Gate 完成后另行制定 Delegation and Hardening 计划。

## 已确认产品方向

- Personal Build 直接使用用户提供的完整 Claude Code `docx`、`pptx`、`xlsx`、`pdf` Skill 包；vc-agent 不另造 Office 引擎，也不把这些包改写为产品自有实现。
- Office Skill 必须由用户显式导入为完整副本，放入隔离的 VC Agent Skills Directory；运行时不得读取 Claude Code 的实时 Skills 根目录。
- 第三方 Office Skill 不提交到本仓库、不由安装器捆绑、不重新分发，也不宣称由 vc-agent 所有。
- 优先使用 Host-owned Compatibility Overlay；如果确实需要直接修改导入包，必须记录并展示本地 diff。
- Office 创建或编辑必须先生成编辑副本和变更摘要；替换原始文件是独立动作，继续受 Access Mode 约束。
- Integration 之前先实现 Runtime Foundation，因为 Office、OCR、MCP Workflow、Extension Audit 和后续 Sub-Agent 必须共用同一个有界调度器。
- 每个 Project 最多一个 Agent Worker，其中不同 Project Thread 使用独立、惰性创建的 Pi Session；每个发生模型工作的 Unscoped Thread 继续使用独立 Worker。
- 固定本地恢复链为：PyMuPDF 原生提取 → 普通 PaddleOCR → 仅对仍缺失、不可靠或结构不足的页面使用 OvisOCR2。
- MCP 只通过捆绑且固定版本的 `pi-mcp-adapter` 暴露，不建立第二套内置 MCP Client 或直连 Provider 的旁路。
- 任意 Pi Extension 在确定性检查、隔离模型审阅、用户显式批准、独立启用和全局空闲激活全部完成前保持不可用。

本计划受 ADR 0027、0028、0034、0036-0039、0043、0057-0059 约束。

## 规划规则

- 每个切片都必须有可见桌面路径、持久运行状态、明确不可用状态、重启行为和测试。
- 保持当前依赖方向。本地可执行依赖通过 Utility Worker 或 Isolated Job 运行，不进入 Renderer、Electron Main 或 Agent Worker。
- 继续使用统一 Host Capability Gateway，不为 Office、OCR、Skills 或 MCP 增加专用 Renderer-to-runtime 通道。
- Skill 指令、MCP schemas、OCR payload 和 Extension tools 只在当前任务需要时激活，不进入所有 Turn。
- 目录检查、依赖诊断、Skill 导入、OCR、Extension 确定性检查、Queue 浏览和 Settings 导航不得启动 Pi。
- Provider Failure 不得触发自动重试、Profile fallback、Provider 切换、阶段跳过、Extension 批准或持久写入。
- Standard Access 确认敏感越界访问和原件替换；Full Access 只取消符合条件的工具级确认，不取消 Output Intent、Cognitive Review、Extension Admission 和可见 provenance。
- 后续 parser、OCR、Office、MCP 或 Extension 动作失败时，保留此前最佳可用结果。
- 英文设计规范和 ADR 继续是行为基准，本计划只安排实现顺序，不扩张产品范围。

## 可复用的现有基础

| 现有能力 | Integration Build 用途 |
| --- | --- |
| Capability Registry 与 Host Gateway | Task-activated Skills、MCP proxy、Office staged writes、受保护 Integration 动作 |
| Runtime Resource Snapshot | 在 Prompt Load Boundary 注入 bounded Skill instructions 和 approved Extension inventory |
| Utility Worker 与 Canonical Parse | Python Job Manifest、PDF 原生提取、页面恢复和 staged parser results |
| Project Output Registry | Office 副本、render preview、diff、source relationship 和 producing Skill provenance |
| Material Inventory 与 Parse Refresh | OCR escalation 和外部修改失效处理 |
| Model Profiles 与 Task Assignments | Document generation、visual material analysis、Extension Audit 和 launch override |
| Thread Trajectory 与 checkpoint | Queue admission、interruption、可见 Integration activity 和 Unknown Tool Outcome |
| Project Identity 与 Provider Authorization | Project Worker ownership、来源访问、MCP/Office scope 和移动目录连续性 |
| Environment Doctor | Skills、Python/OCR、Office dependency、MCP adapter 和 Extension 状态 |
| State Migration boundary | Queue、Skill inventory、MCP configuration 和 Extension revision schema |

## Runtime 与存储边界

默认应用级 Integration 目录：

```text
<app-data>/skills/
  active/
  imports/
  overlays/
  inventory.json

<app-data>/integrations/
  mcp/
  extensions/
    staged/
    approved/
    revisions/

<app-data>/jobs/
  staged/
  results/
  logs/
```

规则：

- Imported Skills 和 approved Extensions 是透明本地目录；SQLite 只保存 id、path、hash、status、permission、revision 和运行协调状态。
- Protected Credentials 继续只保存为 OS-protected references，不进入 Skill、Extension、Job Manifest、日志、备份或 Provider 可见结果。
- Job 输入输出必须有界、版本化并绑定单个 request；持久 Output 或 parse artifact 提交后，按临时 payload 规则清理。
- Skills 不得写 Project Memory、Long-term Memory、Reflection 或 Dream 状态；认知变更继续走现有 Host-owned review path。
- Approved Extension 仅在其声明的直接进程行为上属于 Trusted Worker Code；Host-proxied 持久状态和权限变更仍由 Host 校验。

## Runtime Foundation 切片

### R0. 建立有界执行调度器与可见队列

**依赖：** Learning Build 完成。

**实现内容：** 为普通 Turn 和模型驱动的 Workflow stage 增加一个 Host-owned 全局调度器，持久化 Queue Entry 与 Lease，按有界容量准入，并把 Active Thread 中新提交的消息保存为可见、可编辑的 Queued Follow-up。

**验收标准：**

- [x] 每个 Thread 最多一个 Active Turn；不同 Thread 只在全局容量范围内并发。
- [x] 普通 Turn、Reflection、Dream、Extension Audit 和后续注册的内部模型 stage 共用同一容量。
- [x] Active Thread 中提交的新消息成为 Queued Follow-up，不能隐式 steering 当前 Turn。
- [x] 用户可在准入前编辑、取消，或在同一 Thread 内调整 queued draft 顺序。
- [x] 因全局容量等待的任务显示原因、scope、Profile 和提交时间。
- [x] Stop 只中断所选 Active Turn，绝不自动提交后续 Queue Item。
- [x] 重启只把 queued content 恢复为未发送 draft，确定性清除 stale lease，不启动 Worker 或 Provider。
- [x] Missing Profile、Profile 不兼容和 Provider Failure 不得永久占用容量或触发 fallback。
- [x] Queue 与 Lease schema 原子迁移，新版不兼容数据进入 Read-only Recovery。
- [x] Telemetry 显示 queue delay、running duration、capacity use 和脱敏 failure count，不发送远程内容遥测。

### R1. 修正 Project Worker 所有权并统一本地资源竞争

**依赖：** R0。

**实现内容：** 把 Agent Worker 监督从每 Thread 一个 Worker 改为每 Project 一个 Worker，并为每个模型驱动的 Unscoped Thread 保留独立 Worker；在 Project Worker 内承载多个相互隔离、惰性创建的 Thread Session，并统一本地 Job 准入。

**验收标准：**

- [ ] 没有提交模型任务的 Project 不启动 Agent Worker。
- [ ] 第一个 Project 任务只启动一个按 Project Identity 而非 path 或 Thread id 标识的 Worker。
- [ ] 多个 Project Thread 使用独立 Pi Session，可在全局容量内并发且不共享模型上下文。
- [ ] 每个模型驱动的 Unscoped Thread 使用独立 Worker，不能访问 Project State path、capability、attachment 或 credential authorization。
- [ ] 移动 Project 目录后通过 Project Identity 保持连续性；identity collision 继续等待显式分类。
- [ ] 关闭应用时 checkpoint Active Work、终止 Agent Worker 与 Isolated Job，不自动 replay。
- [ ] Utility/Isolated Job 崩溃不影响 Host、Agent Worker、此前 parse、此前 Output 和最佳早期阶段结果。
- [ ] Python、OCR、render 和 Skill executable job 的 process-tree cancellation 有界且经过验证。
- [ ] 同目标并发写入使用 staged validation 与现有 Access Mode collision policy，不进行模型隐式合并。
- [ ] Worker integration tests 覆盖同 Project 双 Thread、多 Project、Unscoped isolation、capacity admission、stop、crash 和 restart。

## Integration 切片

### I1. 建立隔离的 VC Agent Skills Directory

**依赖：** R1。

**实现内容：** 增加应用级 Skills Directory、确定性 package inventory、完整目录显式导入、兼容性诊断、Host-owned overlay、activation metadata 和 task-activated Skill resource projection。

**验收标准：**

- [ ] 只有用户打开或配置 Skills view 时才惰性创建目录。
- [ ] 默认目录与 Claude Code、Codex、Pi、project-local 和其他 global Agent Skills 根目录隔离。
- [ ] Import 先把完整 package 复制到 staged location，包括 `SKILL.md`、引用的 scripts/resources、metadata 和 license。
- [ ] 导入后不再读取外部 live Skill root，也不静默更新 package。
- [ ] Inventory 记录 package id、source kind、import time、content hash、compatibility status、declared dependencies、overlay revision 和 enabled state。
- [ ] 缺失引用文件、不支持的 directive、路径逃逸、未声明 executable dependency 或 metadata 异常会阻止激活并显示诊断。
- [ ] 优先把兼容修改放入 Host-owned overlay；直接 package 修改必须有 visible diff 和显式批准。
- [ ] Skill instructions/tool schemas 只进入相关任务的 Runtime Resource Snapshot。
- [ ] Skill 无法绕过 cognitive-state exclusion、Output Intent、Project scope、Provider Authorization、Access Mode 和 Capability validation。
- [ ] Backup 包含 active Skills 与 overlay metadata，但排除 external source path、secret、cache 和 job payload。

### I2. 直接调用用户提供的 Claude Code Office Skills

**依赖：** I1。

**实现内容：** 通过 Skills boundary 导入并直接调用用户提供的 Claude Code `docx`、`pptx`、`xlsx`、`pdf` Skill；增加 controlled file/script capabilities、dependency diagnostics、staged output validation、edited-copy workflow、可用时的 render/preview 和 change summary。

**验收标准：**

- [ ] vc-agent 直接使用完整导入的 Claude Code Office Skills，不实现平行 Office document engine。
- [ ] 仓库和安装器不包含第三方 Office Skill、model weight 或未声明 binary dependency。
- [ ] Environment Doctor 显示每个 Office Skill 的完整性、所需 runtime/binary、可选 Microsoft Office dependency 和可操作的 unavailable reason。
- [ ] Document-generation task 只激活相关 Office Skill 和最小 controlled capabilities。
- [ ] 新建文档写入确定的 Output Location，并记录 producing Skill、Thread、Turn、Profile、source references 和 warnings。
- [ ] 编辑 Project Material 时先生成 edited copy 和可审阅 change summary/diff，不静默替换原件。
- [ ] Standard Access 下替换原件需要二次确认；Full Access 下仍必须是可见的显式动作。
- [ ] Dependency 缺失、Skill/render 失败或 Office COM 不可用时保留原件与已验证 staged copy；不使用 LibreOffice fallback。
- [ ] Skill script 作为 bounded Isolated Job 运行，声明 input/output、timeout、cancellation 和 sanitized logs，不继承整个 Project filesystem access。
- [ ] 已派发替换发生 Unknown completion 时标记 Unknown Tool Outcome，检查目标或显式接受 duplicate risk 后才能重试。
- [ ] E2E 覆盖生成文档、编辑副本、diff review、拒绝/批准替换、依赖不可用和重启检查。

### I3. 复用 Skill Creator 显式 Meta-Skill

**依赖：** I1，以及 I2 形成的兼容经验。

**实现内容：** 导入一个完整兼容的 Claude Code 或 Codex Skill Creator，通过相同 overlay 机制适配，并提供带 destination、dependency、content 和 diff review 的显式创建/更新工作流。

**验收标准：**

- [ ] 仅在用户显式要求时启动，不从普通成功对话自动触发。
- [ ] 只在 VC Agent Skills Directory 内创建或更新 staged package。
- [ ] 完整保留引用的 scripts、resources、metadata 和 license，缺失时阻止激活。
- [ ] Standard Access 在写入前审阅 destination、package、dependency 和 diff；Full Access 仍保留可见 review record。
- [ ] 新建或更新的 Skill 经过与 imported Skill 相同的 compatibility、path、dependency 和 activation 检查。
- [ ] Skill Creator 无 cognitive-state write、Extension approval、Protected Credential 或自动 enable 权限。
- [ ] 失败时保持此前 active version 不变，并在安全时保留可审阅 draft。

### I4. 增加本地 PaddleOCR 与 OvisOCR2 页面恢复

**依赖：** R1 和现有 Canonical Parse boundary。R1 后可与 I1-I3 并行。

**实现内容：** 扩展 Utility/Isolated Job parser registry：保留可用 PyMuPDF 结果，对缺失或不可靠页面使用普通 PaddleOCR，仅对仍不可靠或结构不足的页面使用 OvisOCR2。

**验收标准：**

- [ ] PyMuPDF 始终最先运行，后续恢复不丢弃可用 native blocks。
- [ ] PaddleOCR 只接收由确定性质量规则选出的 bounded rendered pages，本地运行且不需要 Pi/Profile。
- [ ] 仅当 PaddleOCR unavailable、unreliable 或 structurally insufficient 时调用 OvisOCR2，不自动换其他 OCR provider。
- [ ] 每阶段记录 adapter/version、page reference、quality、duration、warning 和 retained-result decision。
- [ ] Canonical Parse 继续输出 parser-independent blocks、tables、geometry、images、warnings 和 stable source references。
- [ ] 后续 stage timeout、cancel、malformed result 或 crash 时保留最佳已验证早期内容。
- [ ] 诊断区分 native parse warning、OCR unavailable、OCR failed 和 complex parse unavailable。
- [ ] External OCR API 继续关闭，除非另行设计和显式启用。
- [ ] App launch、inventory、Environment Doctor 不加载 model weights 或启动 inference。
- [ ] 测试覆盖 native/scanned/mixed page、unreliable OCR、layout escalation、依赖缺失、timeout、cancel 和 crash containment。

### I5. 通过固定 Pi Adapter 接入 MCP

**依赖：** R1 与 Capability Gateway；R1 后可独立于 Office/OCR 开展。

**实现内容：** 捆绑并固定 `pi-mcp-adapter`，增加应用级 server configuration/status，仅在任务激活 MCP 时懒连接，通过 Host capability metadata 投影工具并执行读写/外部提交权限边界。

**验收标准：**

- [ ] MCP 仅通过固定 adapter 提供，不存在 Renderer、Host 或第二套 MCP Client 旁路。
- [ ] Settings 展示 adapter version、server、credential-reference、status、capabilities 和 sanitized failure，打开页面不连接。
- [ ] 普通 Turn 默认没有 MCP schemas，只有 deterministic preactivation 或已批准 Capability Activation Request 才加入。
- [ ] Read-only retrieval 使用 bounded result、visible provenance 和 Turn-scoped large-payload retirement。
- [ ] Write、external submission、sampling、elicitation、local-file upload 和 permission expansion 经过 Host permission boundary。
- [ ] Standard Access 执行必要确认；Full Access 只取消符合条件的工具确认，不扩大 server/Project authorization。
- [ ] Server failure、schema change、timeout 或 Provider Failure 不触发 server/client fallback。
- [ ] Unscoped Thread 不因配置 MCP server 自动获得 Project file/state access。
- [ ] Protected Credential 只保存引用，不进入 export、log、trajectory 或 tool result。
- [ ] Fixture tests 覆盖 lazy connect、activation、bounded read、deny/approve write、disconnect、schema mismatch 和无 eager connection 的 restart。

### I6. 实现 Extension Admission 与 Global Revision Control

**依赖：** R1、I1 inventory mechanics 和当前 pinned bundled Extension boundary。

**实现内容：** 增加用户选择本地 artifact 的 staged acquisition、完整 dependency closure 确定性检查、隔离 Extension Audit、显式 approval、独立 global enablement、immutable approved artifact、Global Extension Revision、idle-boundary activation、update、disable 和 rollback。

**验收标准：**

- [ ] Staged 或 reviewing Extension 保持在 Pi discovery/execution 之外。
- [ ] Deterministic inspection 无需 Pi，记录 artifact identity/hash、source revision、lock/dependency closure、lifecycle scripts、permissions 和 integrity gap。
- [ ] Immutable identity、integrity evidence 或 deterministic dependency resolution 不完整时禁止批准。
- [ ] Extension Audit 仅在用户显式启动后运行，隔离 Projects、ordinary Threads、Skills、VC prompt 和所有 Memory/Reflection/Dream state。
- [ ] Audit 只解析 Extension Audit Task Assignment 或 explicit override；missing Profile/Provider Failure 保留 deterministic results 并等待手动操作。
- [ ] Report 区分 deterministic finding、model review、未审 transitive surface、requested permission 和 residual risk，不声称完全安全。
- [ ] 只有用户能批准；Agent、audit model、Full Access、update flow 和 Extension 自身都不能 self-approve。
- [ ] Approval 与 Global Enablement 是两个显式动作，新批准 Extension 默认 disabled。
- [ ] Runtime load 必须精确匹配 approved bytes、dependency lock、source revision、permission declaration 和 retained artifact identity。
- [ ] Enable、disable、update、rollback 形成一个 pending Global Extension Revision，只在全局 idle boundary 原子激活。
- [ ] Immediate activation 必须显式 interrupt/checkpoint，终止旧 Worker，不自动 resume/replay。
- [ ] 仅允许 rollback 到 bytes 仍匹配 approval identity 的 retained artifact。
- [ ] Extension revision 同时应用 Project 与 Unscoped Worker，本 Build 不提供 per-Project override。
- [ ] 公开说明 direct Extension behavior 属于 Trusted Worker Code；Host-proxied durable/permission action 继续校验。
- [ ] Audit input、artifact、trajectory 排除 Memory capture、Dream、ordinary recall、Personal Cognition Backup 和 Project Output，除非用户显式 export report。

## Integration 退出切片

### G3. 通过 Practical Integration Workflow Gate

**依赖：** R0-R1 与 I1-I6。

**实现内容：** 稳定共享 scheduler，并为 imported Office Skills、OCR recovery、Skill Creator、MCP 和 approved Extension lifecycle 分别提供真实可见路径；不要求所有可选依赖都安装。

**验收标准：**

- [ ] Playwright 场景跨多 Thread queue work、保持上下文隔离、中断一个 Turn、编辑/取消 Queued Follow-up，并在重启后只恢复检查而不自动提交。
- [ ] Project-worker 场景证明两个 Project Thread 共用一个 Worker 但 Pi Session 独立；Unscoped 工作保持进程和 scope 隔离。
- [ ] 一个 fixture Claude Code Office Skill 以完整包导入，完成 document task、edited copy、diff 和 explicit replacement policy。
- [ ] OCR E2E 使用 fixture 验证 PyMuPDF、PaddleOCR、OvisOCR2 路由，并在后续失败时保留最佳结果。
- [ ] Fixture MCP server 验证 lazy activation、bounded read、protected write、visible provenance 和无 eager connection 的 restart。
- [ ] Fixture Extension 完成 deterministic inspection、isolated audit、approval、separate enablement、idle activation、update invalidation 和 rollback。
- [ ] Skill Creator fixture 创建 staged Skill，通过 compatibility review 但不自动 activate。
- [ ] Office/OCR dependency missing、MCP failure、Audit Provider Failure、job timeout、worker crash、stale output 和 restart 都形成可见可恢复状态，不 fallback、不破坏旧结果。
- [ ] Environment Doctor 显示 Pi、Profile、credential、storage、migration、Skills、Office、OCR、MCP 和 Extension revision 的脱敏状态。
- [ ] Architecture tests 保证 Renderer isolation、Pi Adapter ownership、Job Manifest boundary、task-activated resources、cognitive-state exclusion，并确保无 Sub-Agent runtime code。
- [ ] 在声明的依赖可用时，唯一用户可以无需开发者介入，导入 Claude Code Office Skills 并完成日常文档工作。

## 依赖关系图

```text
Learning G2 -> R0 -> R1 -----+-> I1 -> I2 -> I3 --+
                             |                     |
                             +-> I4 ---------------+-> G3
                             |                     |
                             +-> I5 ---------------+
                             |                     |
                             +-> I1 -> I6 ---------+
```

R1 完成后，I4 与 I5 可和 Skills 路径并行。I6 复用 I1 的 inventory/integrity mechanics，但 Skill compatibility 结果不能被当作 Extension approval。

## 阶段 Gate

**Integration Build 完成：** R0-R1、I1-I6 和 G3 全部通过。用户可以运行有界并发任务，从隔离 Skills Directory 直接使用自己提供的 Claude Code Office Skills，在本地恢复扫描页和复杂页面，按需激活 MCP，显式创建个人 Skill，并通过可见 Host-controlled 流程批准、启用或回滚 Extension。

以下能力继续保持不可用，直到 Delegation and Hardening Build：显式 Sub-Agent Run、child task tree、child Profile resolution、shared child Token Budget、child Capability Set、bounded handoff、parent-stop propagation 和 Sub-Agent trajectory retention。后续实现必须复用本计划建立的 scheduler、Project Worker ownership、Capability Gateway、Runtime Resource Snapshot 和 interruption semantics。
