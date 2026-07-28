# 分层能力目录与模型自主工具调用开发方案

> 日期：2026-07-28
> 状态：In Progress（已完成 P0 与 P1/P2/P3 的第一纵向切片；P4-P6 待后续切片）
> 范围：普通 Project / Unscoped Turn 的工具可见性、动态激活、执行授权、证据轨迹与真实 Provider 验证
> 不在本轮范围：Reflection、Dream、Extension Audit、Sub-Agent 的授权语义重做；新增浏览器、Office 或 MCP 业务能力

> 当前实现说明：普通 Turn 已使用 `TurnCapabilitySurface` 生成 common-read 与 bootstrap broker 面，broker 已支持 catalog/activate、目录 revision 和逐项拒绝；Worker/`activeCapabilities` 仍保留为同安装包内的迁移兼容字段，待受保护工作流一起完成原子协议切换后移除。

## 1. 目标与问题

当前普通 Turn 由 Host 对用户文本执行关键词/正则判断，再把命中的能力 ID 写入 `activeCapabilities`。这个实现把自然语言意图识别变成了工具可用性的硬门槛：

```text
自然语言未命中
  → activeCapabilities 为空
  → Provider 收不到任何工具 schema
  → 模型无法读取材料、联网或申请其他能力
  → Prompt 约束成为防止幻觉的唯一防线
```

本方案采用“方向三：分层能力目录 + 按需暴露 schema”，目标是：

1. 模型自主判断是否需要读取材料、Project Context、公开网络或其他能力。
2. Host 继续独占 scope、availability、Access Mode、User Intent Gate、Cognitive Review Gate 和实际执行授权。
3. 关键词检测只作为减少一次工具往返的 preload hint，不再决定正确性。
4. 普通研究任务永远不存在“零工具且无自救入口”的状态。
5. 常见材料分析和公开信息核验无需先调用 broker。
6. 工具数量增长、MCP 接入或大 schema 出现后，不需要把全部 schema 注入每个 Turn。
7. 工具目录、Provider schema、Gateway 执行集合和轨迹使用同一份 Capability Registry 元数据，避免漂移。

## 2. 核心设计决策

### 2.1 模型选择能力，Host 决定可见与可执行

必须拆分两个当前混在 `activeCapabilities` 中的概念：

- **Visible Capability**：Provider 当前能看到完整工具 schema，模型可以生成调用。
- **Executable Capability**：Host Gateway 在当前 Turn 中允许受理的能力；仍需通过 scope、state version、前置条件和确认检查。

工具可见不等于授权扩大。尤其是写入、登录态、外部操作和认知工作流，模型的申请不能替代用户意图或确认。

### 2.2 普通 Turn 使用分层工具面

| Tier | 初始策略 | 第一版能力 |
|---|---|---|
| `bootstrap` | 普通 Turn 始终可见 | `capability_request` |
| `common_read` | scope 与 runtime 可用时直接可见 | `material_recall`、`project_state_recall`、`web_search`、`web_fetch` |
| `on_demand` | 目录可发现，完整 schema 初始隐藏 | 后续 Office、PDF、浏览器、MCP、大 schema 能力 |
| `preconditioned` | 满足显式用户意图后可见或可申请 | `output.write_text` |
| `protected_workflow` | 仅对应工作流可见 | Reflection outcome、Dream、Memory 写入 |
| `host_only` | 永不进入模型工具面 | Host 管理、配置、迁移、凭据管理 |

第一版的普通 Project Turn：

```text
capability_request
material_recall            # Project 存在 active Materials 时
project_state_recall       # Project Context 可用时
web_search                 # Public Web capability 可用时
web_fetch                  # Public Web capability 可用时
```

第一版的普通 Unscoped Turn：

```text
capability_request
web_search
web_fetch
material_recall            # 仅在 Direct Thread Attachments 真正实现且存在时
```

`memory_recall` 第一阶段保持 on-demand。它进入 common read 前，必须先完成“automatic eligible”与“explicit-only”授权范围的拆分，避免模型自主调用绕过 Memory Recall 政策。

### 2.3 正则只保留为 preload hint

现有 `detectMaterialRecallIntent()`、`detectWebResearchIntent()` 等函数可以保留，但语义改为：

```text
命中   → 允许把低频能力提前放入 visible 集合，减少 broker 往返
漏判   → 模型仍能直接使用 common_read 或通过 broker 申请
误判   → 最多增加 schema token，不扩大执行权限
```

测试重点从“所有自然语言都必须被正则识别”转为“无论提示词如何表达，模型始终拥有发现和申请能力的入口”。

### 2.4 不把当前工具列表写死进 Minimal VC System Prompt

Minimal VC System Prompt 只增加稳定行为原则：

```text
When a conclusion depends on Project Materials or current external facts,
retrieve the relevant evidence before making factual claims.

Use available tools autonomously when they materially improve the answer.
If a required capability is not currently exposed and capability_request
is available, use it to discover or request the capability.

Never claim that a Material, webpage, or public source was reviewed unless
a successful tool result supports that claim. If retrieval fails or is
unavailable, state the limitation explicitly.
```

不在 Prompt 中列具体能力 ID 或复制 JSON Schema。直接可用工具由 Provider tool schema 表达；隐藏工具由 broker 的 `catalog` 操作返回。这样工具事实只有 Capability Registry 一个来源。

### 2.5 Broker 使用“发现 + 激活”两阶段 Interface

为避免依赖 Pi 在持久会话内动态替换 `capability_request` 自身的参数 schema，第一版不把动态 enum 写进 broker schema，而使用稳定 Interface：

```ts
type CapabilityRequestInput =
  | {
      mode: "catalog";
      need: string;
    }
  | {
      mode: "activate";
      need: string;
      capabilityIds: string[];
      catalogRevision: string;
    };
```

`catalog` 返回当前 Turn 可申请能力的紧凑目录：

```ts
interface CapabilityCatalogResult {
  readonly catalogRevision: string;
  readonly entries: readonly {
    id: string;
    label: string;
    useWhen: string;
    sideEffectClass: SideEffectClass;
    requiresUserIntent: boolean;
  }[];
}
```

`activate` 返回逐项结果：

```ts
interface CapabilityActivationResult {
  readonly catalogRevision: string;
  readonly activated: readonly string[];
  readonly alreadyVisible: readonly string[];
  readonly rejected: readonly {
    id: string;
    code:
      | "CAPABILITY_UNAVAILABLE"
      | "SCOPE_REJECTED"
      | "STALE_CATALOG"
      | "USER_INTENT_REQUIRED"
      | "WORKFLOW_REQUIRED";
    reason: string;
  }[];
}
```

激活必须满足：

- 仅对当前 Turn 有效。
- 幂等。
- 单次最多申请 8 个能力。
- 单个 Turn 最多成功扩展 16 个能力。
- 激活后仍由 Gateway 在执行时重新校验。
- `catalogRevision` 或 `expectedStateVersion` 过期时拒绝，不静默使用新目录。

## 3. 深 Module 与 Interface

在 `packages/capabilities` 新建 `TurnCapabilitySurface` Module。其外部 Interface 控制在三个入口：

```ts
export interface TurnCapabilitySurface {
  prepareTurn(context: TurnCapabilityContext): CapabilitySurfaceSnapshot;

  activate(
    snapshot: CapabilitySurfaceSnapshot,
    request: CapabilityActivationRequest
  ): CapabilityActivationResult;

  authorizeExecution(
    snapshot: CapabilitySurfaceSnapshot,
    request: CapabilityExecutionRequest
  ): CapabilityExecutionAuthorization;
}
```

建议的数据结构：

```ts
export type TurnKind =
  | "ordinary"
  | "reflection_independent"
  | "reflection_dialogue"
  | "dream"
  | "extension_audit"
  | "sub_agent"
  | "compaction";

export interface TurnCapabilityContext {
  readonly turnId: string;
  readonly kind: TurnKind;
  readonly scope: ExecutionScope;
  readonly accessMode: AccessMode;
  readonly stateVersion: number;
  readonly availability: CapabilityAvailabilitySnapshot;
  readonly explicitAuthorizations: {
    readonly outputRequested: boolean;
    readonly explicitMemoryRecall: boolean;
    readonly reflectionOutcomeRequested: boolean;
  };
  readonly preloadHints: readonly string[];
  readonly schemaTokenBudget: number;
}

export interface CapabilitySurfaceSnapshot {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly turnId: string;
  readonly visibleCapabilityIds: readonly string[];
  readonly executableCapabilityIds: readonly string[];
  readonly requestableCatalog: readonly CapabilityCatalogEntry[];
  readonly initialToolSchemaEstimatedTokens: number;
}
```

Module 的 Implementation 隐藏：

- Capability Registry inventory 与稳定排序。
- tier 分类和默认可见策略。
- scope、Turn kind、runtime availability 过滤。
- preload hint。
- schema token budget。
- catalog revision/hash。
- 动态激活的幂等状态。
- protected/preconditioned capability 排除。
- visible/executable 集合一致性。

### 3.1 不把所有 Turn 都变成普通 Turn

`turn.execute` 同时用于普通会话、Reflection、Dream、Extension Audit 和 Sub-Agent。Module 必须以 `TurnKind` 为强制输入：

- `ordinary`：使用本方案的 tiered surface。
- `reflection_*`：保持冻结工作流能力集；不自动加入普通 broker。
- `dream`：保持固定、最小、隔离的能力集。
- `extension_audit`：保持隔离且默认无 Project/Memory 工具。
- `sub_agent`：继续使用显式 Sub-Agent Capability Set，不继承父 Turn 的 broker 或 common reads。
- `compaction`：无模型工具。

禁止在 Worker 层通过“如果 active 为空就默认加 broker”实现，否则会破坏受保护工作流隔离。

## 4. 协议与 Adapter 变化

### 4.1 Contracts

修改 `packages/contracts/src/capability.ts`：

- 新增 `capabilityTierSchema`。
- 新增 `capabilityCatalogEntrySchema`。
- 新增 `capabilitySurfaceSnapshotSchema`。
- 新增 `capabilityActivationRequestSchema`。
- 扩展 `capabilityExecutionResultSchema`，用结构化 activation 结果替代只有 `activatedCapabilities` 的弱表达。

修改 `packages/contracts/src/worker.ts`：

```ts
const executeTurn = workerCommandBase.extend({
  // ...
  capabilitySurface: capabilitySurfaceSnapshotSchema,
  // 删除 activeCapabilities
});
```

这是同一安装包内 Host/Worker 的原子协议变更，不保留长期 `activeCapabilities` 兼容层。所有生产调用方必须在同一切片更新，避免一个字段长期表达两种模型。

需要更新的调用方：

- ordinary Turn
- Reflection independent/dialogue
- Dream extraction/synthesis
- Extension Audit
- Sub-Agent Provider Executor
- compaction/rebuild
- tests 中所有 `turn.execute` fixture

### 4.2 Agent Worker

`apps/agent-worker/src/index.ts`：

- `session.submit()` 接收 `capabilitySurface`。
- 只把 `visibleCapabilityIds` 交给 Pi。
- 保存当前 surface revision，拒绝不匹配 Turn 的 activation resolution。
- 动态激活后更新本地 visible set。
- 不自行解释 scope、Access Mode 或 User Intent。

### 4.3 Pi Adapter

`packages/pi-adapter/src/pi-session.ts`：

- 将 `submit(prompt, { activeCapabilities })` 改为 `submit(prompt, { capabilitySurface })`。
- 初始调用 `setActiveToolsByName(surface.visibleCapabilityIds)`。
- `capability_request` 成功后只合并 Host 返回的 `activated`。
- `catalog` 调用不修改 active tool set。
- 动态激活下一次 Provider sampling 必须看到新工具 schema。

当前 `createCapabilityProxies()` 手写了第二份工具 schema。方案后半程应增加一个 `PiToolSurfaceAdapter`，从 Registry 的 JSON Schema/metadata 生成 Pi tool definitions，使以下内容只有一个权威来源：

- ID
- label
- description / `useWhen`
- input schema
- output schema

Host 的 Zod schema继续承担可信参数校验；Provider schema只用于模型工具生成。

### 4.4 Host Main

`apps/desktop/src/main/main.ts`：

- `submitTurn()` 不再直接组装 `activeCapabilities`。
- 构造 `TurnCapabilityContext`，调用 `prepareTurn()`。
- `TurnContext` 保存不可变初始 snapshot 和当前动态 visible set。
- `processCapabilityRequest()` 对 broker 的 catalog/activate 与普通执行分流。
- `capabilityAuthorization()` 使用 `executableCapabilityIds`，不再使用 visible 集合。
- activation 后记录轨迹、更新 Turn 状态并把结果返回 Worker。

## 5. Capability 分类修正

在迁移前对当前 inventory 做一次显式分类：

| Capability | 目标分类 | 说明 |
|---|---|---|
| `capability_request` | `bootstrap` | 仅普通 Turn 始终可见 |
| `material_recall` | `common_read` | Project 有 Material 时直接可见 |
| `project_state_recall` | `common_read` | 仅 Project |
| `web_search` | `common_read` | Public network read |
| `web_fetch` | `common_read` | Public network read |
| `memory_recall` | `on_demand` | 完成 recall-policy 拆分后再考虑 common |
| `output.write_text` | `preconditioned` | 用户明确要求或批准 Action Proposal |
| `reflection_evidence_drilldown` | workflow scoped | 不应继续作为普通 Project capability |
| `reflection_outcome_propose` | `protected_workflow` | 仅 Reflection 显式阶段 |

Registry metadata 应增加 `tier` 和简短 `useWhen`。`description` 继续描述工具行为和结果约束，`useWhen` 专门用于模型选择与紧凑目录。

## 6. Telemetry、轨迹与 UI

### 6.1 Turn 提交记录

`turn.submitted` 至少记录：

- `capabilitySurfaceRevision`
- `visibleCapabilityIds`
- `requestableCapabilityCount`
- `initialToolSchemaEstimatedTokens`
- preload hint 命中结果

不得只记录 `toolSchemaEstimatedTokens=0/非 0`。

### 6.2 动态激活记录

新增 `capability.surface.activated` 轨迹事件：

```ts
{
  catalogRevision,
  requestedCapabilityIds,
  activatedCapabilityIds,
  rejected: [{ id, code }],
  addedToolSchemaEstimatedTokens
}
```

目录正文不需要进入轨迹；目录 revision 和结果足以审计，避免未来 MCP metadata 形成大日志或 Prompt 注入载体。

### 6.3 UI

普通成功激活继续显示为现有 tool activity。诊断详情增加：

- 初始工具面；
- 动态加入工具；
- 被拒绝的能力及原因；
- 是否使用材料/Web retrieval。

不在普通对话中展示完整 catalog dump，除非用户打开“输出/上下文”诊断面板。

## 7. Evidence Discipline 加固

工具自主性只能降低幻觉概率，不能单独保证模型一定调用工具。第一版采取三层措施：

1. System Prompt 增加稳定的“先取证、后断言”和 broker 使用原则。
2. 工具 description 明确使用场景，例如 `material_recall` 必须覆盖“项目文件、附件、BP、技术成果、财务材料”。
3. 轨迹记录本 Turn 是否产生 material/web retrieval，供 UI 和后续 guard 使用。

不在第一阶段用回答文本正则做强制拦截，这会复制当前意图识别问题。后续 Evidence Guard 仅在存在确定性信号时启用：

- 用户从 UI 明确选中 Material；
- Prompt 精确引用 inventory 中的文件名；
- 显式 workflow 声明 evidence-required；
- Output contract 要求稳定来源引用。

在这些场景中，如果没有对应 retrieval，完成结果必须降级为“证据未读取/未核验”，不得声称基于材料或公开信息。实现强制 guard 前先记录 telemetry，评估误拦截率。

## 8. 分阶段开发切片

### P0：ADR 与基线测试

目标：先固定新语义，防止实现阶段在“全工具默认”与“任务激活”之间摇摆。

任务：

1. 修订 ADR-0033：
   - 普通 Turn 不再允许完全空的自救工具面；
   - common read 可按 scope 默认可见；
   - broker 是普通 Turn bootstrap；
   - preload hint 不扩大授权；
   - protected workflows 保持隔离。
2. 更新 `CONTEXT.md` 中 `Minimal Default Harness`、`Task-activated Capability`、`Capability Activation Request`。
3. 为本次真实中文提示保存回归 fixture。
4. 增加当前失败基线：
   - 原提示不得得到零工具面；
   - tool claim 与 retrieval trajectory 可对照。

完成标准：

- 文档不再要求“ordinary Turn may have an empty tool surface”。
- 新旧能力语义无冲突。

预计：0.5 天。

### P1：TurnCapabilitySurface Module 与 Contracts

目标：建立新的深 Module 和唯一测试 seam，不先改变 Provider 行为。

任务：

1. 新增 Module、types、tier policy、stable revision。
2. 输入 runtime availability snapshot，不在 Module 内直接读取 StateStore。
3. 为所有 TurnKind 生成确定性 surface。
4. 原子替换 Worker `activeCapabilities` 协议。
5. 所有旧调用方先生成与当前行为等价的 fixed surface。

测试：

- ordinary Project/Unscoped surface。
- Reflection/Dream/Audit/Sub-Agent/compaction 隔离。
- stable ordering/revision。
- scope、availability、protected classification。
- schema budget。

完成标准：

- `main.ts` 不再直接决定具体 active ID 列表。
- 所有 Worker command 使用 `capabilitySurface`。
- 行为仍与迁移前等价。

预计：1-1.5 天。

### P2：Common Read + Always-on Broker 垂直切片

目标：关闭“意图漏判导致零工具”的主故障。

任务：

1. ordinary Turn 始终加入 `capability_request`。
2. 按 scope/availability 加入 common reads。
3. 正则输出只进入 `preloadHints`。
4. 更新 prompt telemetry。
5. 更新工具 descriptions。

关键回归：

```text
分析一下公司的重点技术成果文件，评估一下公司的技术能力。
```

预期：

- Project 有材料时 `material_recall` 对模型直接可见。
- Public Web 可用时 `web_search` / `web_fetch` 对模型直接可见。
- 模型可以从 cards 开始并触发目标文件按需解析。
- 即使模型不调用工具，也不能把“工具不存在”作为理由。

完成标准：

- exact prompt 的 `visibleCapabilityIds` 非空且包含材料/Web 读取。
- 普通问候可以不调用任何工具。
- Unscoped Turn 不出现 Project-only 能力。

预计：0.5-1 天。

### P3：Broker Catalog 与动态激活

目标：让隐藏能力可发现、可按需加入，不依赖具体关键词。

任务：

1. broker 支持 `catalog` / `activate`。
2. catalog 从 surface snapshot 生成。
3. 激活支持多能力、revision、幂等和逐项拒绝。
4. Pi 在同一 Turn 更新 active tool names。
5. 新增 activation trajectory。
6. 限制 broker 次数、新增工具数和动态 schema token。

测试：

- catalog 不泄露 scope 外、host-only、workflow-only 能力。
- activate 后下一次模型采样能看到新 schema。
- 重复激活返回 already-visible。
- stale revision 被拒绝。
- output capability 未满足用户意图时不激活。
- catalog metadata 中的外部/MCP 文本经过长度限制和清洗。

完成标准：

- 模型可以在不知道隐藏能力 ID 的情况下先发现再激活。
- 动态激活不形成 Standing Permission。

预计：1-1.5 天。

### P4：Visible/Executable 授权收口与 Schema 单一来源

目标：消除可见性与授权混用，减少 Registry/Pi schema 漂移。

任务：

1. Gateway 只接受 surface 的 executable 集合。
2. 执行时重新验证 scope、stateVersion、User Intent 和 confirmation。
3. `output.write_text` 维持 User Intent Gate：
   - 明确输出意图可激活；
   - 否则只能返回 Action Proposal 或 `USER_INTENT_REQUIRED`。
4. `reflection_evidence_drilldown` 重分类为 workflow scoped。
5. 增加 Pi Tool Surface Adapter，由 Registry metadata 生成工具定义。
6. 删除 Pi Adapter 中手写的重复 schema。

完成标准：

- visible 集合不能绕过 executable 集合。
- 工具 ID、description、input schema 只有一个权威来源。
- 受保护工作流测试保持绿色。

预计：1-2 天。

### P5：Memory 与 Evidence Guard

目标：在不扩大认知授权的前提下提高自主 recall，并为证据缺失建立可观测降级。

任务：

1. 将 `memory_recall` 的执行范围拆为：
   - automatic-eligible cards；
   - 用户明确请求后可用的 explicit-only entries。
2. 模型可申请 memory tool，但不能通过申请扩大 recall policy。
3. 增加 material/web retrieval usage telemetry。
4. 在确定性 evidence-required 场景启用完成前 guard。
5. UI 显示“材料未读取”“公开信息未核验”等降级状态。

完成标准：

- Memory 仍不是来源证据。
- 未发生 retrieval 时不会产生伪造的“基于材料/公开信息”状态。
- 普通推理任务不会被误要求联网或读材料。

预计：1-1.5 天。

### P6：真实 Provider 与 Release Gate

目标：证明方案不只在 faux Provider 中成立。

任务：

1. 增加独立真实兼容性脚本，建议：

```bash
pnpm capability-surface:compat
```

2. 使用保存的 MIMO Profile 验证：
   - common-read 直接调用；
   - broker catalog；
   - broker activate；
   - 动态加入后的第二次工具调用；
   - material cards → target material parse → excerpt；
   - web search → fetch；
   - rejected write activation；
   - Provider 不支持工具时的明确降级。
3. 证据写入仓库外，只保留脱敏状态、工具 ID、revision、usage、延迟和终态。
4. 将证据检查加入 Personal Build Gate。

完成标准：

- MIMO 真实多步 tool-use 通过。
- 失败不自动换 Provider。
- 凭据、材料正文、Prompt 和模型正文不进入兼容性证据。

预计：0.5-1 天编码，另加真实运行时间。

## 9. 测试矩阵

| ID | 场景 | 层级 |
|---|---|---|
| TCS-T-001 | 任意 ordinary Turn 都有 `capability_request` | Unit |
| TCS-T-002 | Project common-read 按 availability 可见 | Unit |
| TCS-T-003 | Unscoped 不暴露 Project Context/Project Materials | Unit |
| TCS-T-004 | protected Turn 不自动继承 broker/common reads | Unit/Integration |
| TCS-T-005 | 原始中文提示不再得到零工具面 | Integration |
| TCS-T-006 | catalog 只返回当前 scope 可申请能力 | Unit |
| TCS-T-007 | activate 幂等、支持多项并返回逐项拒绝 | Unit |
| TCS-T-008 | stale catalog/state version 被拒绝 | Unit/Integration |
| TCS-T-009 | 动态激活后 Pi 下一采样看到新 schema | Pi Adapter |
| TCS-T-010 | visible capability 不能绕过 executable policy | Gateway |
| TCS-T-011 | write 仍要求用户意图/确认 | Integration/E2E |
| TCS-T-012 | common reads 可见但普通问候不误调用 | Provider fixture |
| TCS-T-013 | target Material 可按需 parse 并返回引用块 | E2E |
| TCS-T-014 | Web search/fetch 产生来源引用 | Integration/Real E2E |
| TCS-T-015 | material/web claim 与 retrieval trajectory 一致 | E2E |
| TCS-T-016 | MIMO 完成 broker → activated tool 多步调用 | Real compatibility |
| TCS-T-017 | 不支持工具的 Profile 明确 block/degrade | Integration |
| TCS-T-018 | catalog/trajectory/telemetry 不含 secret 或材料正文 | Security |
| TCS-T-019 | schema budget 超限时低优先级工具转 on-demand | Unit |
| TCS-T-020 | compaction/restart 后不保留前一 Turn 动态激活 | E2E |

## 10. 文件影响清单

预计新增：

- `packages/capabilities/src/turn-capability-surface.ts`
- `tests/capabilities/turn-capability-surface.test.ts`
- `scripts/run-real-capability-surface-compat.ts`
- 对应 release evidence schema/test

预计修改：

- `CONTEXT.md`
- `docs/adr/0033-use-a-minimal-vc-prompt-and-task-activated-capabilities.md`
- `packages/contracts/src/capability.ts`
- `packages/contracts/src/worker.ts`
- `packages/contracts/src/trajectory.ts`
- `packages/capabilities/src/index.ts`
- `packages/host-services/src/system-prompt.ts`
- `packages/pi-adapter/src/pi-session.ts`
- `apps/agent-worker/src/index.ts`
- `apps/desktop/src/main/main.ts`
- `apps/desktop/src/main/sub-agent-provider-executor.ts`
- `apps/desktop/src/main/extension-audit-worker.ts`
- `apps/desktop/src/renderer/App.tsx`
- 相关 Unit、Integration、E2E、Gate tests

## 11. 风险与控制

### 11.1 Schema token 增长

控制：

- common-read 白名单保持小而稳定。
- surface 有明确 schema token budget。
- 超预算能力自动降为 on-demand。
- 记录初始和动态新增 schema token。

### 11.2 模型误调用或过度联网

控制：

- tool description 明确 `useWhen`。
- retrieval 有 max items/chars 和 Turn budget。
- 普通问候回归测试。
- 记录无效/重复调用率，先观测再调整 common tier。

### 11.3 Broker 循环

控制：

- catalog/activate 幂等。
- 每 Turn broker 调用次数和新增能力上限。
- 已可见能力返回 `alreadyVisible`。
- 连续无新增的 activate 不再触发 schema 更新。

### 11.4 Provider 动态工具兼容性

控制：

- faux Pi test 不能代替真实 MIMO 多步调用。
- Profile Capability Check 记录 tool-use 为 supported/unsupported/unknown。
- unknown 在 evidence-required 任务中应提示兼容性风险或阻断，不得静默无工具执行。

### 11.5 工作流权限回归

控制：

- TurnKind 是 Module 必填输入。
- ordinary 默认策略不得应用到 Reflection、Dream、Audit、Sub-Agent。
- protected workflow isolation 纳入协议级测试。

### 11.6 Registry 与 Provider schema 漂移

控制：

- Registry metadata 是唯一来源。
- Pi Tool Surface Adapter 只做格式转换。
- CI 对 Registry inventory 与安装到 Pi 的工具定义做 snapshot/differential test。

## 12. 每阶段验证命令

开发过程中：

```bash
pnpm typecheck
pnpm vitest run tests/capabilities/turn-capability-surface.test.ts
pnpm vitest run tests/pi-adapter/tracer.test.ts
pnpm vitest run tests/capabilities/material-recall.test.ts tests/capabilities/public-web.test.ts
```

完成确定性实现后：

```bash
pnpm verify
pnpm integration-gate:release
pnpm personal-build-gate
```

真实 Provider 验收：

```bash
pnpm capability-surface:compat
pnpm personal-build-gate:release
```

## 13. 工期与建议提交切片

| Commit | 内容 | 预计 |
|---|---|---:|
| 1 | ADR/CONTEXT、失败回归、Module skeleton | 0.5 天 |
| 2 | Contracts + fixed surfaces 原子迁移 | 1-1.5 天 |
| 3 | ordinary common reads + always-on broker | 0.5-1 天 |
| 4 | broker catalog/activate + trajectory | 1-1.5 天 |
| 5 | visible/executable 收口 + Pi schema 单一来源 | 1-2 天 |
| 6 | Memory/evidence telemetry 与确定性 guard | 1-1.5 天 |
| 7 | MIMO real compatibility + Gate/docs | 0.5-1 天 |

合计约 5.5-8.5 个有效开发日，不含等待外部 Provider 或人工产品验收时间。

每个 commit 都必须保持：

- 不扩大 Project/Unscoped scope。
- 不绕过 Access Mode、User Intent Gate 或 Cognitive Review Gate。
- 不自动切换 Provider。
- 不让动态能力跨 Turn 持久化。
- 不把凭据、材料正文、Prompt 或完整 Provider 响应写入证据。

## 14. 最终 Definition of Done

以下条件同时满足才算完成：

1. 原始 MindVerse 提示在 Project Turn 中获得 material/web common-read 工具面。
2. 普通 Turn 始终存在 broker，自然语言漏判不再造成零工具死路。
3. 正则只影响 preload，不影响能力可发现性。
4. 模型能通过 catalog 发现隐藏能力，并在同一 Turn 动态激活和调用。
5. visible/executable 语义分离，Gateway 保持最终授权。
6. Reflection、Dream、Audit、Sub-Agent、compaction 的隔离没有回归。
7. Registry 是工具 ID、描述和 schema 的唯一来源。
8. 初始与动态工具面可在轨迹和 telemetry 中审计。
9. 材料/Web retrieval 有稳定来源引用，确定性 evidence-required 场景不会伪造已读/已搜索状态。
10. Unit、Integration、E2E、Integration Gate 和 Personal Build Gate 通过。
11. MIMO 真实完成 common read 和 broker 动态激活多步调用。
12. ADR、CONTEXT、运行文档与最终实现一致。
