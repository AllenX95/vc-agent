# Foundation 与 Dogfood 实施计划（中文审阅版）

日期：2026-07-16

> **仅供审阅**
>
> 本文是英文实施计划的中文审阅副本，不是开发基准。开发、Issue 拆分、验收测试和后续变更均以英文文档 [`2026-07-16-foundation-dogfood-implementation-plan.md`](./2026-07-16-foundation-dogfood-implementation-plan.md) 为唯一依据。若中英文存在歧义或不一致，以英文文档为准。对需求的正式修改应先写入英文文档，再同步本审阅副本。

来源：`docs/superpowers/specs/2026-07-06-vc-desktop-agent-design.md`

## 目标

交付一条从空白桌面应用到日常 VC 工作的最小可运行路径：用户可以配置 Provider，通过 Pi 对话，查看并按需解析本地 Project 资料，研究公开网页，召回有边界的 Project 状态，生成带来源引用的 Output，并保留经用户批准的 Project Memory。

本计划只覆盖 Foundation 和 Dogfood Build。Learning Build、Integration Build、Delegation And Hardening、任意 Extension 准入、Office Skills、OCR、MCP、Dream、Long-term Memory、Investment Reflection 和 Sub-Agent 均不在本计划范围内。

## 规划原则

- 按可在桌面应用中独立演示的垂直切片实施，每个切片都包含持久化、失败行为和测试。
- 从第一次模型调用开始就保持 Host control plane 与 Pi execution plane 的边界。
- 在第一个真实 Pi SDK tracer 跑通前，不为 Pi 预先构建替代性抽象。
- 后续阶段的功能应保持不可用，而不是提供模拟成功或不完整路径。
- 只使用随应用捆绑、已经审计且固定版本的 Extension 清单，拒绝任意 Extension 获取。
- 已确认的设计规格和 ADR 是行为依据；本文只安排实施顺序，不替代产品决策。

## 后续兼容性契约

Foundation 或 Dogfood 不包含某项后续功能，表示暂缓它的 Adapter 和 UI，而不是封闭它未来要使用的 seam。当前切片必须通过真实的当前行为建立下列 interface，但不得提前建设空插件框架、占位功能包、推测性 Settings 或虚假的后续 Adapter。

| 后续能力 | 本计划当前建立的 seam | 当前兼容性要求 |
| --- | --- | --- |
| Office Skills 和 Skill Creator | Capability Registry、Utility Job Runner、Output Store、Artifact Registry | 首个 text/Markdown Adapter 使用与格式无关的 job、staged result、Output 和 provenance contract。Core 和 UI 不能假定所有 Output 都是 Markdown 或都能按文本编辑。 |
| PaddleOCR、OvisOCR2 和未来 parser | Material Pipeline、Parser Adapter registry、Canonical Parse | 原生 parser 输出与 parser 无关的 blocks 和 warnings。后续 Adapter 按固定顺序实现 PyMuPDF 原生提取 -> 普通 PaddleOCR -> OvisOCR2 页面恢复，不得要求第二套 material model 或新的模型可见工具；每个阶段保留与 parser 无关的 provenance、validation result 和此前最佳可用结果。 |
| MCP | Capability Registry、Task Activation、Host Capability Gateway、runtime resource snapshot | Web 和本地工具使用 MCP proxy 以后会复用的 capability metadata、authorization、event 和 bounded-result contract。MCP 特有行为不得进入 core policy。 |
| Skill Import 和 Skill loading | 应用控制的 ResourceLoader 和不可变 runtime resource snapshot | 仅捆绑版本从 Host 提供的 snapshot 获取资源，Pi Adapter 内部不扫描目录，也不硬编码 package path。Integration 后续只替换 snapshot producer，不替换 Pi session orchestration。 |
| Extension Admission 和更新 | ResourceLoader 使用的不可变 Extension Inventory Snapshot | Foundation 只接受捆绑且固定版本的条目。Integration 后续通过同一 snapshot shape 提供已批准的全局 revision；未审计制品不得进入 Worker loading path。 |
| Long-term Memory、Dream、Investment Reflection | 版本化 Thread Trajectory、有 scope 的 Memory Recall sources、显式 write command | Project Memory 保持为 project-scoped source。后续用户级 memory 和 review workflow 增加独立 source 和 command，不改变历史 trajectory 的含义，也不把当前 Project Memory 变成通用 unscoped store。 |
| Sub-Agent 和更广泛 concurrency | Worker Supervisor、版本化 execution/event envelope、provenance actor metadata | 当前 Primary Agent 使用同一套 actor-aware envelope 和 supervision interface。后续 child actor 增加 scheduling 和 record，而不改变已经持久化的 Turn、tool、Output 或 provenance identity。 |

兼容规则是：**增加 Adapter，不替换现有路径**。后续功能可以增加注册的 capability metadata、新 parser 或 output adapter、新 scoped recall source 或新 Worker actor，但不能要求 Renderer 直接调用 Pi、把产品策略移动进 Worker、让 Host-mediated action 绕过 Host Capability Gateway、重新解释既有 trajectory event，或把全部既有 Output 迁移到某项功能专属 schema。

Interface 应保持少而深：

- `pi-adapter` 对 Host 隐藏 Pi session 创建、resource loading、model submission、streaming 和 physical-context persistence。
- Capability Registry 和 executor 对 Pi 与 Renderer 隐藏 activation、authorization、dispatch、bounded result 及 event/provenance recording。
- Material Pipeline 隐藏 parser selection、versioning、stale handling、page recovery 和 Canonical Parse persistence。
- Utility Job Runner 隐藏 process launch、cancellation、bounded log、staging、validation 和 final commit。
- Output Store 和 Artifact Registry 隐藏 destination policy、atomic commit、media type、producer identity 和 source relationship。
- Worker Supervisor 隐藏 process lifecycle，并路由版本化、actor-aware 的 command 和 event。

以上每个 interface 只能在第一个真正使用它的切片中引入，并同时具备一个真实 Adapter 和用于测试的 in-memory 或 fixture Adapter。本兼容性工作不包含通用 marketplace、plugin SDK、workflow engine、service mesh 或 feature-flag platform。

## 建议工具链

- 使用 `pnpm` workspaces 的单一 TypeScript workspace。
- 桌面应用使用 Electron、React、Vite 和 TypeScript。
- Host Operational State 使用 SQLite；用户可见的权威内容使用透明的 JSONL 和 Markdown 文件。
- 单元测试与契约测试使用 Vitest；桌面端到端测试使用 Playwright。
- Pi SDK 固定版本，并隔离在 `packages/pi-adapter` 后面。

F1 开始时应固定所有具体依赖版本。可以改用其他包管理器或测试框架，但不得改变 workspace 和依赖方向契约。

## Foundation 切片

### F1. 启动空白桌面应用

**前置依赖：** 无。

**建设内容：** 创建有明确依赖方向的 workspace、Electron Main、React Renderer、类型化 preload IPC、Host 所有的 SQLite 初始化，以及架构契约测试。应用启动后展示空白三栏界面，不创建 Project、Thread、Model Profile、凭据、Worker、Pi session 或 Provider 请求。

**覆盖的用户需求：** 首次启动无需配置即可使用本地界面；本地导航和 Settings 保持为 Host-only。

**验收标准：**

- [ ] 应用可以启动并显示空白界面和 Settings。
- [ ] Renderer 不能导入文件系统、Electron Main、持久化、Provider 或 Pi 模块。
- [ ] 只有 `pi-adapter` 可以导入 Pi SDK；`core` 不包含 Electron、Pi、SQLite 或 Python 类型。
- [ ] Architecture contract tests 强制 workspace 依赖方向，并阻止后续 feature package 或 runtime Adapter 被导入 `core` 或 Renderer。
- [ ] 版本化 command/event envelope 支持 actor/provenance identity，不把 Primary Agent 编码成不可改变的 singleton。
- [ ] 启动、进入 Settings 和退出应用不会创建 Agent Worker，也不会发出网络请求。
- [ ] 不受支持的 IPC schema 版本会被拒绝，并显示本地诊断信息。
- [ ] Playwright smoke test 可以启动并关闭开发版桌面应用。

### F2. 完成一次 Unscoped Pi Turn

**前置依赖：** F1。

**建设内容：** 允许用户创建带 OS 保护凭据引用的命名 Model Profile，创建 Unscoped Thread，选择 Active Model Profile，提交文本，按需启动隔离的 Agent Worker，执行一次真实 Pi SDK Turn，流式显示回复，并在不自动 fallback 的情况下显示经过清理的 Provider Failure。

**覆盖的用户需求：** Provider 中立的对话；没有默认 Profile；类似 Codex 的 Thread 交互；按需启动 Pi。

**验收标准：**

- [ ] 创建和查看空 Thread 不会启动 Pi。
- [ ] 没有有效 Profile 时提交消息，会保留 prompt 并显示 `Model Profile not configured`，且不启动 Worker。
- [ ] 用户手动配置 Profile 后重试，会启动一个隔离的 Unscoped Worker，并按顺序流式显示文本 delta。
- [ ] 自定义 ResourceLoader 排除 Project/global `.pi`、`.agents`、`AGENTS.md`、外部 Skills、settings、auth 和任意 Extensions。
- [ ] 只能加载随应用捆绑、经过审计且固定版本的 Extension 清单。
- [ ] Pi Adapter 使用由 Host 提供的不可变 Runtime Resource Snapshot 和 Extension Inventory Snapshot；session orchestration 不扫描资源目录，也不硬编码捆绑 package path。
- [ ] Provider 错误展示解析后的人类可读文本，保留 User Turn，并允许手动重试或调整 Profile，不自动 fallback。
- [ ] UI 记录有效 Profile、Provider、Model、可获得时的 token 用量和完成状态。

### F3. 保存并恢复 Thread Trajectory

**前置依赖：** F2。

**建设内容：** 将 Host 所有的 Thread Trajectory 与 Pi Physical Model Context 分开持久化，增加 In-flight Turn Checkpoint、Stop、应用重启恢复、高水位对账和同一 Thread 续聊，并增加跨 Provider 继续当前 Thread 或新建 Thread 的明确选择。

**覆盖的用户需求：** 持久对话历史；停止后不隐藏恢复；安全切换 Provider。

**验收标准：**

- [ ] 完成的消息和终态工具事件会 append 并 flush 到 `trajectory.jsonl`。
- [ ] 流式部分内容通过原子替换 checkpoint 保存，不记录隐藏推理、凭据或原始授权载荷。
- [ ] Stop 或崩溃只产生一个可见的 Interrupted Turn，且不会自动恢复、重放工具或提交排队文本。
- [ ] 重启后仅查看历史不会启动 Pi；继续对话时才按需重建 Physical Model Context。
- [ ] 稳定事件 ID 和高水位标记可以防止 checkpoint 恢复后重复写入终态内容。
- [ ] 持久化 execution、tool 和 artifact event 包含版本化 actor/provenance reference，当前表示 Primary Agent，后续可表示 Sub-Agent，而无需重新解释旧 event。
- [ ] 跨 Provider 切换必须选择 `Continue Current Thread` 或 `Start New Thread`，并记录选择和保留上下文披露。

### F4. 执行一个经授权的 Host Capability

**前置依赖：** F2。

**建设内容：** 实现类型化 Capability Registry 和 Host Capability Gateway、Standard Access、Full Access、可见的能力执行事件、Output Intent，以及一个窄范围的 Unscoped 文本输出 Adapter。该 Adapter 通过共享 staging、Output Store 和 Artifact Registry 路径，将文件写入用户选择的 Output Location。

**覆盖的用户需求：** 可观察的 Agent 操作；两档访问模式；通过明确意图创建文档，而不是自动导出对话。

**验收标准：**

- [ ] 模型工具调用通过带版本的 IPC，包含 Thread、Turn、capability、scope、参数、correlation id 和预期状态版本。
- [ ] Capability metadata 声明 activation class、input/output schema、side-effect class、scope requirement 和 executor identity；增加后续 capability 不需要新增 Pi-to-Host IPC method 或 Renderer branch。
- [ ] Host 在产生副作用前拒绝未激活、未授权、过期或超出 scope 的请求。
- [ ] 普通对话在没有 Output Intent 时不会创建文件。
- [ ] 明确保存请求在缺少 Unscoped Output Location 时要求用户选择目录，并在该目录原子创建可见文件。
- [ ] Standard Access 对敏感的越界或替换操作要求确认；Full Access 取消工具级确认，但仍显示事件和 provenance。
- [ ] 无法确认已派发且不可 staging 的写操作是否完成时，状态变为 Unknown Tool Outcome，且不会自动重试。
- [ ] 首个 text Output 记录与格式无关的 media type、producer、destination 和 source/provenance relation，而不是把 Markdown 定义为 Output domain model。

### F5. 打开稳定 Project 并运行 Project Thread

**前置依赖：** F3、F4。

**建设内容：** 将本地文件夹注册为 Project，创建最小 Project Identity 标记，创建 Project Threads，保持对话隔离，通过显式使用 Profile 建立 Project Provider Authorization，并处理文件夹移动和复制导致的身份冲突。

**覆盖的用户需求：** Project 范围内工作；文件夹移动后的连续性；避免意外跨 Project 上下文。

**验收标准：**

- [ ] 打开文件夹时只创建带随机 identity 的 `outputs/system/project.json`，其中不包含路径或业务内容。
- [ ] Project 注册和 Thread 浏览在提交工作前保持 Host-only。
- [ ] Project Thread 可以通过同一 Pi 路径执行，而 Unscoped Thread 不能访问 Project State。
- [ ] 为 Project 选择外部 Profile 会记录 Project Provider Authorization，但不会主动读取或上传文件。
- [ ] 重新打开移动后的文件夹可以通过 Project Identity 恢复 Threads 和元数据。
- [ ] 在两个路径发现相同 identity 时停止注册，直到用户选择 `Moved Project` 或 `Project Copy`。
- [ ] 同一 Project 中的两个 Thread 保持独立 conversation 和 Physical Model Context。

## Dogfood 切片

### D1. 加载并修订 Minimal VC System Prompt

**前置依赖：** F2。

**建设内容：** 提供包含六类职责的 Minimal VC System Prompt，将 active revision 加入每次普通 Provider 调用，并实现直接编辑、diff/history、激活、恢复默认、Prompt Load Boundary 行为和 prompt 占用遥测。

**覆盖的用户需求：** 用较小 harness 实现 VC 专属判断行为；通过 prompt-first 方式学习产品实践。

**验收标准：**

- [ ] 每个普通 Turn 包含 active Minimal VC System Prompt revision，默认不包含 Project 特定内容。
- [ ] 默认 Prompt 只包含已确认的六类职责。
- [ ] 保存会创建包含 hash、timestamp、可选备注和可审阅 diff 的 revision。
- [ ] 已激活的 physical context 不会在上下文中途热加载编辑后的 Prompt。
- [ ] 应用重启、新 Thread 和 compaction/rebuild 会在定义的边界加载最新 active revision。
- [ ] Turn provenance 记录 prompt revision，以及可估算或可观察的 prompt、tool 和 context 占用。

### D2. 盘点 Materials 并检测外部变化

**前置依赖：** F5。

**建设内容：** 为支持的文件增加确定性 Material Inventory、稳定 source hash、外部变化检测、stale parse 状态和明确的 Parse Refresh Choice UI。打开 Project 时不解析文件正文。

**覆盖的用户需求：** 在持续变化的项目文件夹上工作，同时避免提前加载上下文或静默复用过期内容。

**验收标准：**

- [ ] 打开 Project 只盘点元数据，不解析或发送文件正文。
- [ ] 稳定检测到外部变化后更新 inventory 元数据，但不改变 Active Turn。
- [ ] 已解析 Material 发生变化后，在下次需要时显示 stale。
- [ ] 两种 Access Mode 下，用户都必须选择 `Create New Parse Version`、`Replace Previous Parse` 或取消。
- [ ] 替换失败时保留旧 parse 和历史引用。
- [ ] Generated Outputs 以及保留的 system/cache 路径按设计排除在普通 Material discovery 之外。

### D3. 生成可复用 Canonical Parse

**前置依赖：** D2。

**建设内容：** 实现有边界的 Utility Job Runner、Material Pipeline 和 Parser Adapter registry，以及 text、Markdown、PDF 原生文本、DOCX、PPTX、XLSX/CSV 和常见结构化文本格式的基础 Adapter。持久化带来源引用的 Canonical Parse artifact 和可见 warning。Pipeline 可以表达供后续 OCR 使用的 page-recovery request；没有注册 recovery Adapter 时，报告 recovery unavailable，不提供占位 OCR 实现，也不模拟成功。

**覆盖的用户需求：** 在不加载 Office Skills 或 OCR 的情况下分析常见 VC 资料。

**验收标准：**

- [ ] Parsing 只由显式 Host 操作或任务需求启动，本地调用时不需要 Pi。
- [ ] 每个 parse 记录 source hash、parser identity/version、blocks、稳定 source references、warnings 和 provenance。
- [ ] Canonical Parse 的 blocks、tables、page references、warnings 和 parser provenance 与具体 parser package 无关，不包含 PyMuPDF、Office 或 OCR 特有的 runtime object。
- [ ] source 与 parser identity 相同时复用当前 parse。
- [ ] PDF 原生提取会把纯图片或不可靠页面标记为需要当前不可用的 OCR，而不是虚构文本。
- [ ] 原生 parser 可以通过 Material Pipeline 请求有边界的 page recovery，而无需知道未来由哪个 OCR Adapter 完成。
- [ ] Parser 崩溃和损坏文件被限制在 Utility Worker 内，不破坏 Host 或 Agent Worker 状态。
- [ ] Parsed artifacts 写入保留的 Project output 结构，并与 User Outputs 明确区分。

### D4. 在有边界的模型上下文中召回 Materials

**前置依赖：** D1、D3。

**建设内容：** 增加 `capability_request`、`material_recall`、确定性预激活、Progressive Material Disclosure、Context References、Turn-scoped Retrieval Payload 退休、Context Budget Management，以及可见的自动/手动 Thread Compaction。

**覆盖的用户需求：** 以较低 Token 成本分析大型文件夹；明确读取当前文件且不静默截断。

**验收标准：**

- [ ] Project 和 Unscoped 的核心工具面符合已确认 scope；Unscoped recall 只能访问直接 attachments。
- [ ] Primary Agent 可以在同一 Turn 内激活允许的 material capability，不需要 classifier 模型调用。
- [ ] Material retrieval 使用类型化 scoped recall-source interface 和通用 bounded-result envelope；后续 Memory 或 MCP recall source 不需要修改 Pi session orchestration。
- [ ] Retrieval 从 cards/outlines 开始，只扩展选中的 block，并保留稳定 source references。
- [ ] 大型 retrieval 正文只在发起它的 Turn 中保持完整，后续变为 Context Reference。
- [ ] 上下文预算不足时，先退休旧 payload、compact 旧对话，并在减少可选召回前保留当前显式输入。
- [ ] 过大的当前 Material 采用渐进处理；Agent 不能声称读过被省略的内容。
- [ ] Compaction 可见，使用当前有效 Profile，且不会写入 Context 或 Memory。

### D5. 执行只读公开网页研究

**前置依赖：** F4、D1。

**建设内容：** 增加 Task-activated 搜索、公开 URL fetch、公开网页/PDF 提取、有边界的结果、内联来源展示，以及不保存网页快照的实时临时行为。

**覆盖的用户需求：** 使用可见来源进行最新行业研究，同时降低默认工具 schema 成本。

**验收标准：**

- [ ] 明确研究意图会预激活 Web 工具；否则 Agent 通过 `capability_request` 请求。
- [ ] Web 工具通过与本地 capability 相同的 Capability Registry 和 bounded-result envelope 注册；Agent Worker 不增加 Web 特有 dispatch path。
- [ ] 公开只读操作无需逐次确认，但保持内联可见。
- [ ] 本切片不提供登录访问、表单提交、写 API、浏览器自动化或本地文件上传。
- [ ] 结果包含 URL、可获得时的 title、访问时间、有边界的内容和 failure warnings。
- [ ] 不创建持久 HTML/body snapshot 或 web evidence cache。
- [ ] 大型 Web 结果遵循 Turn-scoped Retrieval Payload 和 Context Reference 规则。

### D6. 召回并维护 Project Context

**前置依赖：** F5、D1、D4。

**建设内容：** 创建固定的 Project Context Markdown template 和结构化 mirror、右侧面板编辑器、确定性 mirror rebuild、显式 context update 流程，以及不默认注入新 Thread 的有边界 `project_state_recall`。

**覆盖的用户需求：** 跨 Thread 共享 Project 事实，同时避免把完整 Project State 复制到每个对话。

**验收标准：**

- [ ] Context 文件按需创建，保持用户可编辑和透明。
- [ ] 新 Thread 默认不接收 Project Context 正文。
- [ ] `project_state_recall` 只返回相关 section，并显示 provenance。
- [ ] 外部手动编辑会在没有模型调用的情况下确定性重建 structured mirror。
- [ ] 格式错误的 section 产生可见 warning，但不会覆盖用户文本。
- [ ] Unscoped Thread 不能调用 Project Context recall。

### D7. 捕获并召回 Project Memory

**前置依赖：** D1、D4、D6。

**建设内容：** 增加 Project Memory editor、无需辅助 classifier 调用的显式/强 User signal inline candidate capture、draft-confirm append、source metadata，以及用于判断型任务或显式召回的有边界 `memory_recall`。Project Memory 注册为一个明确 project-scoped 的 recall source，而不是未来 Long-term Memory 的 storage model。

**覆盖的用户需求：** 保存项目层面的判断，同时把模型输出、来源事实和经确认的 User Memory 分开。

**验收标准：**

- [ ] 默认不完整注入 Project Memory。
- [ ] 显式或强 User signal 可以在没有额外模型请求的情况下产生可见 candidate。
- [ ] 只有用户确认后，candidate 内容才 append 到 Project Memory。
- [ ] Manual edit 是权威内容，并在没有模型调用的情况下重建 recall index。
- [ ] Recall 将 Memory 标记为经用户确认的判断，而不是 source evidence，并在对话中显示召回活动。
- [ ] Recall result 携带 source scope 和 maturity metadata，使后续 Long-term Memory source 可以加入 ranking，而无需改变既有 Project Memory record 或其权威性。
- [ ] 未批准的模型陈述、Outputs 和 source summaries 不会自动成为 Project Memory。
- [ ] Unscoped Thread 不能读写 Project Memory。

### D8. 生成带来源引用的 Project Output

**前置依赖：** D3、D4、D5、D6。

**建设内容：** 将 Output Intent 和与格式无关的 Output Store 扩展到 Project Thread，使用 Markdown output Adapter 从 parsed material 和可选 Web research 生成首个 VC Deliverable，记录 artifact provenance，并在 Outputs 面板展示。Markdown 是第一个具体 Adapter，不是 Output domain model。不引入 draft/final 分类。

**覆盖的用户需求：** 通过同一套 conversation-first workflow 生成行业研究、项目判断或投资 Memo。

**验收标准：**

- [ ] 用户明确请求后，在确定的 Project Output Location 下创建适合任务的文件。
- [ ] 文档在必要时区分 sourced facts、inference、uncertainty 和重要的 User/model disagreement，但不实行 evidence maximalism。
- [ ] Material claims 使用稳定 parse references，Web claims 在可获得时使用可见 URL。
- [ ] Artifact registry 记录 source-output 关系、Thread/Turn、Profile、Provider、tool、timestamp 和 warnings。
- [ ] Output metadata 支持 media type、producing capability/Skill、可选 render/diff artifact 和任意文件扩展名，无需修改 schema；UI 当前打开 Markdown，对未知未来格式显示通用文件操作。
- [ ] Supporting files 保持在 Output Location 下，并对用户可见。
- [ ] 普通分析对话在没有 Output Intent 时仍不会创建 Output。

## Dogfood 退出切片

### G1. 通过日常 VC 工作流 Gate

**前置依赖：** F1-F5、D1-D8。

**建设内容：** 稳定一条端到端 Project 工作流及其失败路径：打开真实 fixture Project，查看 inventory，解析选定 materials，执行公开网页研究，使用有边界的 Context 和 Memory 讨论投资判断，生成带来源引用的 Output，重启应用，并在不触发隐藏工作的情况下继续 Thread。

**覆盖的用户需求：** 为唯一用户提供完整 Dogfood Build 工作闭环。

**验收标准：**

- [ ] 一个 Playwright E2E scenario 通过可见 UI 操作完成整个工作流。
- [ ] 第二个 scenario 覆盖 missing Profile、Provider Failure、parse warning、stopped Turn 和 restart recovery，且不发生数据损坏或自动 fallback。
- [ ] 应用启动和浏览本地状态不会激活 Pi。
- [ ] Telemetry 展示 prompt、tool schema、recall、retained context、output reserve、latency 和 token 占用，但不发送远程内容 telemetry。
- [ ] Environment doctor 报告 Pi、Provider、parser、credential reference、storage 和 bundled Extension 状态，并使用经过清理的 diagnostics。
- [ ] Architecture tests 通过 ResourceLoader、Capability Registry、Parser Adapter、Output Store 和 Worker Supervisor interface 运行 fixture Adapter，不导入后续阶段的 feature code。
- [ ] Learning、Integration、Extension Audit、Office、OCR、MCP、Dream、Reflection、Long-term Memory 和 Sub-Agent 控件均不得表现为可用功能。
- [ ] 唯一用户无需开发者介入即可使用该版本完成普通 VC 工作。

## 依赖关系图

```text
F1 -> F2 -> F3 -----> F5 -> D2 -> D3 -> D4 ----+
       |     |         |             |          |
       |     +-> F4 ---+             +-> D6 -> D7
       |          |                  |          |
       +-> D1 ----+------------------+----------+-> D8 -> G1
                  +-> D5 -----------------------+
```

## 阶段 Gate

**Foundation 完成：** F1-F5 在干净机器配置上通过。用户可以打开空白应用、配置 Profile、运行并恢复 Unscoped 和 Project Threads，并通过 Host 边界创建一个经授权的文件。

**Dogfood 完成：** D1-D8 和 G1 通过。用户可以使用本地 Materials 和公开网页来源完成日常 VC 工作流，并获得有边界的上下文、可见 provenance、Project Context、Project Memory 和持久 Output。

## Issue 发布

当前仓库尚未定义 issue tracker。切片粒度和依赖关系获得批准后，可以选择：

1. 在 `.scratch/` 下配置本地 Markdown issue tracker；或者
2. 初始化正式 Git 仓库，并把切片发布到对应的 GitHub/GitLab tracker。

在此之前，英文实施计划是按依赖排序的正式实施 backlog；本文仅用于中文审阅。
