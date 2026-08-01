# Personal Build Finalization Development Plan

Date: 2026-07-27
Status: Complete — P0 through P5 validated on the current build
Language: Chinese execution plan; normative product authority remains the original English design and accepted ADRs
Product authority: `docs/superpowers/specs/2026-07-06-vc-desktop-agent-design.md`
Predecessor: `docs/superpowers/plans/2026-07-22-personal-build-completion-implementation-plan.md`

## Final Reconciliation (2026-07-27)

本计划中的早期 baseline 和 historical progress 段落保留审计轨迹；当前发布状态以本节和 `docs/superpowers/plans/2026-07-26-post-g3-development-plan-and-spec.md` 为准。

- `pnpm verify`：56 个测试文件、241 个单元/集成测试、32 个 fixture/unavailable E2E 全部通过。
- `pnpm integration-gate:release`：G3-T-001 至 G3-T-011 全部通过。
- `pnpm sub-agent:compat`：保存的 MIMO Profile、Provider child、Output adoption、stop/cancel、budget exhaustion、Provider Failure 和 secret scan 全部通过。
- `pnpm h1:packaged`：process-tree、Microsoft Word external-edit、backup/restore、single-instance 四类证据通过。
- `pnpm personal-build-gate:release`：H1-S-001 至 H1-S-010 全部通过。
- Microsoft Office 是唯一 DOCX 桌面兼容目标；不使用 LibreOffice。真实 MCP 使用 vc-agent 自有 filesystem runtime，证据只写仓库外。

## 1. Purpose

本文将 2026-07-26 最新代码审查结论沉淀为后续开发执行方案。目标不是继续扩展新能力，而是按可验证的顺序：

1. 恢复可信、可重复的一键测试基线。
2. 将 Integration 桌面路径从 fixture surface 收敛为真实用户路径。
3. 关闭真实 Office、MCP 和 G3 Integration Gate。
4. 完成真实 Provider-backed Sub-Agent Delegation。
5. 关闭 H1 Hardening 和完整 Personal Build 验收。
6. 使设计、计划、实现、测试和证据状态重新一致。

本文负责阶段排序、模块边界、交付物、退出门、测试和提交策略。具体产品行为仍以原始设计、accepted ADR、C0-C2、D1、H1 executable SPEC 为准。

## 2. Current Baseline

### 2.1 Initial audit baseline (before this work)

- `main` 与 `origin/main` 一致，审查起点为提交 `d961053`。
- TypeScript workspace typecheck 通过。
- Unit run 中 208 tests 通过、3 tests skipped，但 suite 因 Canonical Parse 测试硬编码系统 `python` 而失败。
- Electron E2E 共 33 tests；当前继承真实 OCR 环境时 28 passed、5 failed。
- 显式设置正确的 parser venv 后，原 5 个失败中的 4 个通过；剩余失败来自 fixture 与真实 OCR 环境串扰。
- Integration Gate：G3-T-001 至 G3-T-010 通过，G3-T-011 blocked。
- Personal Build Gate：H1-S-001 至 H1-S-010 中 9 个通过，H1-S-004 blocked。

### 2.2 Completion assessment at plan creation

- Foundation、Dogfood、Learning 的主要确定性路径已经实现。
- C0 runtime baseline 基本关闭。
- C1 Host services、IPC、状态投影和 fixture UI 路径已实现，但桌面 surface 仍包含大量 fixture-specific 默认值和合成上下文。
- C2 的真实 OCR evidence 已被 Gate 接受；真实 Office、MCP evidence 尚未关闭。
- D1 的 Run/Task/Attempt、调度、持久化、停止、重试、删除和 fixture adapter 已实现；生产环境仍使用 `UnavailableSubAgentAdapter`。
- H1 runner 和大部分确定性矩阵已实现；真实 Integration、真实 Delegation 和 packaged lifecycle evidence 尚未共同通过。

### 2.3 Known concrete gaps and current disposition

1. **Resolved:** Canonical Parse tests now use the shared parser runtime resolver rather than directly spawning `python`.
2. **Resolved:** Playwright fixture runs now use an allowlisted child environment; real tests use an explicit `@real` command.
3. **Resolved:** Integration Settings consumes selected Project/Thread/Turn/Profile context, generic MCP configuration, explicit Skill Creator inputs, and a complete Office Create/Edit/Review file-picker/output/review path.
4. **Resolved for P1:** Production Extension Audit runs through a dedicated isolated Agent Worker session with a bounded snapshot, no ordinary context, no Skills/Extensions, and no capabilities. Real Provider evidence remains part of release evidence closure.
5. **Resolved:** Production Sub-Agent runtime uses the Provider-backed adapter; the fixture path is enabled only by an explicit test flag.
6. **Resolved:** Project and Unscoped Delegation preserve their intended scope at UI, IPC, Context Compiler, and Runtime boundaries.
7. **Resolved:** Child Output records use Host Capability Broker registration and explicit parent adopt/reject review with producer/request provenance.
8. **Resolved:** D1 evidence is validated by a typed inspector and covers Provider, Output, adoption, stop, budget, failure, usage, context hashes, and secret scan.
9. **Resolved:** P3, P4, and the Release Gate passed; remaining documentation is synchronized in this plan, the Completion Spec Index, H1/G3 specs, and the local MCP runbook.

### 2.4 Historical implementation progress (2026-07-26)

P0 is complete in the current working tree:

- Added `apps/utility-worker/src/python-runtime.ts` as the shared parser Python resolver.
- Utility Worker and Desktop Utility Worker launch paths now carry parser runtime configuration.
- Canonical Parse tests use the resolved parser executable instead of hardcoded system `python`.
- Added a controlled Playwright child environment that does not inherit real `VC_AGENT_*` activation flags.
- Tagged local OCR as `@real` and excluded it from the default fixture E2E command.
- Added strict `integration-gate:release` and `personal-build-gate:release` commands.
- Added unit coverage for parser resolution, E2E environment isolation, and Gate exit policy.

Verified on this baseline:

- `pnpm typecheck`: pass.
- `pnpm test`: 48 files, 220 tests, pass.
- `pnpm test:e2e`: 32 tests, pass; real OCR is intentionally excluded.
- `pnpm verify`: pass after the P1 changes (`pnpm typecheck`, 48 files/220 unit tests, build, and 32 fixture/unavailable E2E tests).
- `pnpm test:e2e:real`: local OCR compatibility remains an explicit real-dependency run; Office, MCP, and Provider evidence are separate commands.
- `pnpm integration-gate:release`: final result is `pass`; G3-T-001 through G3-T-011 all pass with external Office/OCR/MCP evidence.
- `pnpm personal-build-gate`: final diagnostic has no blocked suite when the validated external evidence paths are configured.
- `pnpm personal-build-gate:release`: final result is `pass`; H1-S-001 through H1-S-010 all pass.

P1 implementation progress:

- Added a shared `IntegrationTaskContext` contract and renderer resolver. Integration actions now consume the active Project/Thread/parent Turn/Profile and current Access Mode; missing prerequisites are visible and disable the action.
- Removed the Renderer fixture Profile fallback, fixed settings Thread/Turn ids, first-Project/first-Profile selection, fixture Office source fallback, and hardcoded MCP tool buttons/arguments.
- Added schema-driven MCP inventory display, lazy Test Connection, separate stdio command/arguments/working-directory and HTTP endpoint/credential-reference fields. Fixture transport is accepted only by the test Host environment.
- Replaced the fixed Skill Creator draft with Create/Update inputs, target Skill selection, objective/constraints/dependency fields, explicit selected Profile display, staged review, and disabled handoff.
- Replaced the production Extension Audit fixture response with an explicit Provider endpoint adapter that sends a bounded, isolated Extension snapshot; deterministic audit remains injectable only in tests and the fixture Gate invokes it through an explicit test-only mode.

P1 is complete in the current working tree:

- Office supports explicit Create, Edit, and Review operations for DOCX, PPTX, XLSX, and PDF.
- The User explicitly selects an active compatible Skill revision, source file, output name, and operation; the authorized Project `outputs/` location is visibly derived.
- Staged copy, change summary, render/preview, provenance, commit state, Standard Access confirmation, and Full Access replacement paths are visible.
- Extension Audit uses a dedicated synthetic Unscoped Agent Worker session with an audit-only prompt and bounded snapshot. It receives no ordinary Thread history, Project/Memory state, Skills, enabled Extensions, or capabilities.
- The complete fixture Integration path, explicit Office Utility Worker runner, Office cancellation, unavailable behavior, restart dormancy, and passive no-activation paths pass.
- `pnpm typecheck`, 50 files/224 unit tests, and 32 fixture/unavailable Electron E2E tests pass.

P2 is complete:

- Provisioned a user-supplied local Office Skill package into vc-agent-owned application directories outside the repository; no vendor source is fetched and no other agent's Skills directory is consulted.
- Ran DOCX create, edit, reopen validation, and controlled replacement through an external Microsoft Word stdin-manifest runner and emitted sanitized Office evidence outside the repository. LibreOffice is neither required nor used.
- Installed the official `@modelcontextprotocol/server-filesystem@2026.7.10` outside the repository, scoped it to a dedicated sandbox, and exercised lazy read, confirmed write, and restart dormancy through `pi-mcp-adapter@1.5.1`.
- Reused the already configured real OCR evidence.
- `pnpm integration-gate:release` passes; G3-T-001 through G3-T-011 all pass and the Integration Gate decision is `pass`.
- Microsoft Word 16.0 created and reopened each DOCX output; the compatibility run also passed the Host structural OOXML validation without an alternate document-engine fallback.

## 3. Program Definition Of Done

The Personal Build is complete only when all of the following are true:

- `pnpm verify` passes reliably in the supported fixture development environment.
- Fixture and unavailable tests cannot accidentally activate user-configured real dependencies.
- Real dependency runs use separate explicit commands and sanitized external evidence.
- Integration Gate reports `pass`, not `blocked`.
- Production Sub-Agent Runs execute real isolated Provider-backed child sessions.
- Project and Unscoped Delegation both preserve their intended scope boundaries.
- Child Outputs use Host validation, provenance, collision handling, and explicit parent adoption.
- Personal Build Gate reports `pass`, not `blocked`.
- A real end-to-end Primary Product Loop succeeds from material ingestion through reviewed durable learning.
- App launch and passive inspection start no Pi session, Provider request, MCP connection, OCR inference, Office runner, Extension audit, or Sub-Agent.
- App shutdown leaves no Agent Worker, Utility Worker, MCP server, OCR process, Office runner, or Isolated Job running.
- Every normative acceptance requirement maps to an automated test or a validated real-dependency evidence artifact.
- Product plans, test counts, checklists, and current status match the implementation.

## 4. Delivery Stages

| Stage | Objective | Estimate | Exit gate |
| --- | --- | ---: | --- |
| P0 | Restore a trustworthy test/runtime baseline | 2-3 engineering days | `pnpm verify` is stable |
| P1 | Productize the desktop Integration paths | 4-6 engineering days | C1 no longer depends on fixture-only UX |
| P2 | Close real Office/MCP and G3 | 2-4 engineering days | Integration Gate is `pass` |
| P3 | Complete real Sub-Agent Delegation | 6-9 engineering days | D1 real E2E and evidence pass |
| P4 | Harden and accept the Personal Build | 3-5 engineering days | Personal Build Gate is `pass` |
| P5 | Reconcile documentation and release state | 1-2 engineering days | Design, plans, tests, and status agree |

External preparation time for the user-supplied Office Skill package, real MCP service, model credentials, or Provider availability is not included in these estimates.

### 4.1 Dependency sequence

```text
P0 Trustworthy Test Baseline
        |
        v
P1 Productized Integration UX
        |
        v
P2 Real Integrations + G3 Pass
        |
        v
P3 Provider-backed Delegation
        |
        v
P4 H1 Hardening + Acceptance
        |
        v
P5 Documentation + Release Reconciliation
```

## 5. P0 — Restore A Trustworthy Test And Runtime Baseline

### 5.1 Objective

Remove environment-dependent false failures and make every later stage depend on a repeatable regression baseline.

### 5.2 P0.1 Shared parser runtime resolution

Implement one shared parser Python resolution policy:

1. Explicit command or injected executable.
2. `VC_AGENT_PYTHON`.
3. The parser venv identified by the configured OCR runtime.
4. System `python` only as the final fallback.

Required behavior:

- Utility Worker, Electron Main, tests, deployment validation, and compatibility scripts use the same policy.
- Missing Python or incomplete dependencies produces `PARSER_RUNTIME_UNAVAILABLE` with a sanitized diagnostic.
- Environment Doctor reports executable source, parser runtime revision, and dependency readiness without importing OCR models.
- Canonical Parse tests stop calling the system `python` directly.

Likely implementation areas:

- `apps/utility-worker/src/index.ts`
- `apps/desktop/src/main/utility-job-runner.ts`
- `tests/capabilities/canonical-parse.test.ts`
- a new shared runtime resolver under `packages/host-services/src/`

Acceptance:

- Canonical Parse unit tests pass with only `VC_AGENT_PYTHON` configured.
- The correct unavailable state appears when the parser runtime is missing.
- Tests do not require modifying the system `PATH`.

### 5.3 P0.2 Fixture and real environment isolation

Introduce explicit test environment profiles:

- `fixture`: real OCR, Office, MCP, Extension Audit, and Sub-Agent execution disabled.
- `unavailable`: required dependencies explicitly absent or failure-injected.
- `real`: only dedicated real-dependency runners may inherit configured external resources.

Required behavior:

- Ordinary Playwright tests construct an allowlisted child environment.
- User-level `VC_AGENT_REAL_*`, Office runner, MCP command, and model runtime settings cannot leak into fixture tests.
- Real OCR, Office, MCP, Delegation, and packaged lifecycle tests carry a dedicated tag or command.
- `pnpm test:e2e` runs only fixture and unavailable coverage by default.
- `pnpm test:e2e:real` runs only explicitly configured real tests.

Acceptance:

- Fixture E2E has the same result whether or not the User has configured a real OCR runtime.
- Real-only tests skip or block explicitly when their dependency is absent.
- No fixture test reports a real parser or model failure.

### 5.4 P0.3 Gate command semantics

Preserve diagnostic collection while adding strict release behavior:

- Default Gate commands may report `blocked` with exit code 0 for local inspection.
- Add `--require-pass` or equivalent release commands.
- Release commands return non-zero for both `blocked` and `fail`.
- Reports retain distinct `pass | blocked | fail` decisions.

Recommended commands:

```text
pnpm integration-gate
pnpm integration-gate:release
pnpm personal-build-gate
pnpm personal-build-gate:release
```

### 5.5 P0 exit criteria

- Workspace typecheck passes.
- Unit tests pass.
- All ordinary Electron E2E tests pass; only explicitly tagged real tests may skip.
- Two consecutive `pnpm verify` runs produce the same result.
- No tracked source change is generated by verification.
- Fixture startup shows zero external runtime activation.

## 6. P1 — Productize The Desktop Integration Paths

### 6.1 Objective

Replace fixture-oriented Settings actions with real User-selectable Project, Thread, Profile, Skill, dependency, source, and output context.

### 6.2 P1.1 Integration Task Context

Introduce a shared context contract:

```ts
interface IntegrationTaskContext {
  projectId?: string;
  threadId?: string;
  turnId?: string;
  profileId?: string;
  outputLocation?: string;
  accessMode: "standard" | "full";
}
```

Rules:

- Use the active Project, Thread, actual parent Turn, selected Profile, and current Access Mode.
- Never silently select `projects[0]` or `profiles[0]`.
- Project jobs require a Project context.
- Unscoped jobs require an explicit Output Location where applicable.
- Missing context disables the action and displays the missing requirement.
- Restart restores the recorded context without starting external work.

### 6.3 P1.2 Office workflow

Required User path:

- Choose Create, Edit, or Review.
- Choose DOCX, PPTX, XLSX, or PDF.
- Select the active compatible Office Skill revision.
- Select an existing source through a file picker for Edit/Review.
- Select or derive the authorized Output Location.
- Record real Project, Thread, Turn, Profile, Skill revision, source references, and warnings.
- Show staged copy, change summary/diff, render/preview status, and commit state.
- Use one staged Standard Access replacement confirmation flow.
- Full Access suppresses the eligible tool confirmation but preserves impact and provenance display.

Failure behavior:

- Missing dependency, runner failure, render failure, stale source, cancellation, and Office unavailability preserve the source and validated staged artifacts.
- Dispatched replacement with unconfirmed completion becomes Unknown Tool Outcome.
- No LibreOffice or alternate hidden fallback.

### 6.4 P1.3 Generic MCP configuration and execution

Required User path:

- Fixture transport appears only in test mode.
- stdio configuration separates command, arguments, and working directory.
- HTTP configuration separates endpoint and protected credential references.
- Test Connection discovers and caches real schemas without injecting them into a Turn.
- The UI displays tool name, description, action class, allowed scopes, schema revision, and bounds.
- Generic tools accept schema-aware arguments rather than hardcoded fixture payloads.
- Standard Access confirms write, submission, upload, elicitation, sampling, or permission expansion actions.
- Full Access suppresses only eligible tool-level confirmation.
- Ordinary Turns receive schemas only through deterministic preactivation or Capability Activation Request.

Acceptance:

- Lazy Test Connection.
- Generic bounded read.
- Denied and confirmed write.
- Schema change and mismatch handling.
- Restart dormancy.
- Bounded result and visible provenance.

### 6.5 P1.4 Skill Creator product path

Replace fixed draft generation with:

- Create or Update selection.
- Package id, name, description, objective, and constraints.
- Target Skill selection for Update.
- Explicit Skill Creator Profile resolution.
- Staged file tree and diff.
- Dependency and compatibility report.
- User review before handoff.
- Handoff into the Skills Directory in disabled state.
- Normal compatibility inspection and activation after handoff.

Skill Creator never receives cognitive-state write tools, Protected Credentials, Extension approval, or automatic activation.

### 6.6 P1.5 Real Extension Audit workflow

Keep deterministic inspection in the Host without Pi. Replace the production fixture audit adapter with an isolated Provider-backed workflow:

```text
Explicit User audit launch
→ resolve Extension Audit Profile
→ construct isolated audit resource snapshot
→ execute a dedicated Agent Worker session
→ preserve deterministic inspection on Provider Failure
→ return findings, residual risk, and limitations
→ separate explicit User approval
```

The isolated audit snapshot may include:

- deterministic inspection report;
- Extension-owned source;
- lifecycle scripts;
- risk-selected direct dependencies;
- declared permissions and unresolved integrity gaps.

It must exclude:

- Projects and ordinary Threads;
- VC system prompt and ordinary Skills;
- Project Context and Project Memory;
- Long-term Memory;
- Reflection and Dream state;
- Protected Credential values.

Fixture audit remains injectable only in tests.

### 6.7 P1 exit criteria

- Production Renderer contains no fixture Profile fallback, fixture MCP tools, or fixed Skill Creator draft.
- Office, MCP, Skill Creator, and Extension Audit use real selected context.
- The sole User can complete every Integration configuration and review action through the desktop app.
- Passive Settings inspection activates no external runtime.
- C1 fixture, unavailable, restart, failure, accessibility, and product-context E2E pass.

## 7. P2 — Close Real Office, MCP, And G3

Status: Complete on 2026-07-26. Sanitized evidence and all dependency/runtime bytes remain outside Git.

### 7.1 Objective

Produce valid sanitized real-dependency evidence and make G3-T-011 pass.

### 7.2 P2.1 Real Office compatibility

Prerequisites:

- Complete User-supplied Office Skill package.
- Declared Python, Node, Office, or rendering dependencies.
- Configured external Office runner.

Execution:

1. Import the complete package.
2. Run compatibility inspection.
3. Explicitly activate the compatible revision.
4. Create a real document.
5. Edit an existing document and produce a reviewable diff.
6. Exercise the controlled source replacement path.
7. Exercise unavailable and failure behavior.
8. Emit sanitized evidence outside the repository.

Evidence must validate:

- package and source revision;
- external runner identity and ready state;
- Microsoft Office provider, Word application identity, and bounded installed version;
- create, edit, and replace workflows;
- produced formats;
- structural validation of generated artifacts;
- absence of source paths, credentials, source content, and runner logs.

### 7.3 P2.2 Real MCP compatibility

Execution:

1. Configure a real stdio or HTTP MCP service.
2. Explicitly Test Connection.
3. Discover real schemas.
4. Execute one bounded read.
5. Execute one confirmed write under scoped authorization.
6. Restart the Host and prove no eager connection.
7. Emit sanitized evidence outside the repository.

Evidence must validate:

- pinned adapter version and package revision;
- lazy read;
- confirmed write;
- restart dormancy;
- schema identity;
- no argument, result body, credential, log, or full command-line export.

### 7.4 P2.3 G3 closure

Required run:

```text
pnpm verify
pnpm integration-gate
pnpm integration-gate:release
```

### 7.5 P2 exit criteria

- G3-T-001 through G3-T-011 pass.
- Integration Gate decision is `pass`.
- Missing-dependency runs still produce correct unavailable states.
- Real evidence remains outside Git.
- C2 and Integration Build documentation is updated to complete.

## 8. P3 — Complete Real Sub-Agent Delegation

Status: Complete. The production Provider-backed adapter, strict Profile resolution, Context Compiler, Host Capability Broker, Output Registry adoption, stop/budget/failure state, typed D1 evidence, and real MIMO compatibility run are implemented and validated.

### 8.1 Objective

Replace the unavailable production adapter with real isolated child Pi sessions while preserving Host authorization, bounded concurrency, flat topology, scope isolation, and auditable Outputs.

### 8.2 P3.1 Runtime ownership

The recommended production path is:

```text
Renderer explicit authorization
→ Electron Main / SubAgentRuntime
→ global Execution Scheduler
→ Project or Unscoped Agent Worker
→ isolated child Pi session
→ bounded result or staged Output
→ Host validation and persistence
→ parent adoption
```

Ownership:

- Renderer owns commands and views only.
- Electron Main owns authorization, limits, scheduler, durable state, and final commit.
- Agent Worker owns child Pi sessions and Physical Model Context.
- `packages/pi-adapter` owns normalized Pi child-session behavior.
- Host capabilities remain the only route to durable product state.

Likely additions:

- Worker command `sub_agent.execute`.
- Worker command `sub_agent.cancel`.
- Worker events for start, usage, tool activity, completion, failure, and interruption.
- A production Desktop-to-Agent-Worker Sub-Agent adapter.
- A child-session wrapper under `packages/pi-adapter`.

### 8.3 P3.2 Real parent task binding

Rules:

- Every Run references the actual parent Thread and Turn.
- Authorization applies only to the current User task.
- Project children receive the Project id but only bounded context references.
- Unscoped children receive no Project id, Project path, Project capability, or Project authorization.
- Children never inherit the full parent trajectory.
- Settings must not synthesize a random parent Turn or force all scopes to `unscoped`.

### 8.4 P3.3 Primary Agent task creation

The User authorizes one current-task Delegation Run. The primary Agent may then create bounded child tasks through a Host-enforced capability.

Add a capability such as `sub_agent_task_create` with these rules:

- Available only to the primary Agent within an active authorized Run.
- Permanently unavailable to child sessions.
- Host validates role, objective, task count, token budget, context references, Capability Set, and Output target.
- Full Access cannot enlarge task count or token budget.
- No child can create a grandchild.

### 8.5 P3.4 Minimal capabilities and context

Default role surfaces:

- Researcher: bounded web, material, and context reads.
- Critic: bounded context and evidence reads.
- Synthesizer: bounded sibling handoffs and parent-provided references.
- Writer: bounded reads plus determined Output write.

Permanent exclusions:

- Project Memory or Long-term Memory write;
- Dream or Reflection launch/resume;
- Scope Elevation;
- credential management;
- Extension approval or enablement;
- Sub-Agent creation;
- arbitrary permission expansion.

### 8.6 P3.5 Scheduler, usage, failure, and retry

- Parent, children, and other model stages share the global scheduler.
- One parent Thread still has only one Active Turn.
- Shared Token Budget includes all child attempts and the defined parent accounting boundary.
- Reaching the budget prevents new model requests.
- Provider Failure does not retry or switch Provider automatically.
- Manual retry creates a new Attempt and consumes the same Run budget.
- Stopping the parent stops unfinished children; completed sibling results survive.
- Restart marks active attempts Interrupted and performs no automatic resume or replay.

### 8.7 P3.6 Child Output staging and adoption

Add explicit product commands:

- `sub_agent.output.inspect`
- `sub_agent.output.adopt`
- `sub_agent.output.reject`

Rules:

- A write-capable child writes to a staged location.
- The Host validates output target, file type, hash, provenance, warnings, and collision state.
- Adoption registers or atomically moves the artifact into the determined Output Location.
- Rejection preserves or removes staged bytes according to an explicit cleanup policy.
- Concurrent same-target writes use the Host collision policy; no implicit merge.
- The parent response shows whether the result was adopted, partially used, or rejected.
- Deleting child details does not delete the adopted Output; provenance becomes `source unavailable`.

### 8.8 P3.7 Validated D1 evidence

Replace the current external-file existence check with a typed validator and dedicated evidence runner.

Required evidence fields:

- schema and sanitization marker;
- build and state schema identity;
- Provider and Model identity;
- child session count;
- task roles and bounded capabilities;
- Project and Unscoped scope coverage;
- parallel research, critic, and synthesis coverage;
- write-capable staged and adopted Output;
- token usage;
- Stop and restart interruption;
- manual retry and separate Attempt;
- no automatic Provider fallback;
- collision result;
- evidence file outside the repository.

Evidence must exclude prompts, child message bodies, hidden reasoning, credentials, tool transport bodies, Project content, and direct personal data.

### 8.9 P3 exit criteria

- A real Provider-backed child session succeeds in the packaged desktop path.
- Project and Unscoped Delegation both pass.
- The primary Agent creates multiple flat child tasks inside one authorized Run.
- A write-capable child produces and adopts a provenance-tracked Output.
- Stop, retry, budget, collision, deletion, and restart E2E pass.
- D1-REQ-001 through D1-REQ-018 each map to automated coverage or validated evidence.
- Ordinary Turns with no explicit delegation make zero child Provider requests.

## 9. P4 — Harden And Accept The Personal Build

Status: Complete. Packaged lifecycle evidence and the real Office/OCR/MCP dependency paths are accepted by the H1 Release Gate.

### 9.1 Objective

Prove that Foundation, Dogfood, Learning, Integration, and Delegation work together in a real packaged desktop lifecycle.

### 9.2 P4.1 Packaged lifecycle evidence

Collect and validate:

- process-tree cancellation for Agent, Utility, OCR, Office, and isolated jobs;
- external Material edit and Parse Refresh Choice;
- Personal Cognition backup and mechanical restore;
- single-instance behavior and focus;
- clean app shutdown with no residual processes.

### 9.3 P4.2 Real Primary Product Loop

Use a real Project, real Profile, and real materials:

```text
Open Project
→ inventory and parse materials
→ invoke OCR when required
→ perform public-web or MCP research
→ explicitly authorize Delegation
→ produce a VC Output
→ create or edit an Office document
→ launch Investment Reflection
→ review Judgment Record and Learning Proposal
→ review and commit a Memory patch
→ restart and verify retained state
```

Run at least two different VC Deliverables so acceptance does not optimize only for one fixed memo template.

### 9.4 P4.3 Failure and security matrix

Required coverage:

- Provider Failure;
- MCP timeout and schema change;
- Unknown Tool Outcome;
- Office runner crash and cancellation;
- OCR timeout, malformed output, and cancellation;
- Worker crash and restart;
- concurrent Output collision;
- stale source and stale parse;
- supported migration failure rollback;
- unsupported newer schema Read-only Recovery;
- secret, path, scope, telemetry, and eager-activation scans;
- trajectory, Sub-Agent, candidate, and Dream deletion cascades.

### 9.5 P4 exit criteria

The following all return success:

```text
pnpm verify
pnpm integration-gate:release
pnpm personal-build-gate:release
```

Additional requirements:

- Personal Build Gate decision is `pass`.
- H1-REQ-001 through H1-REQ-020 pass.
- No open severity-1/2 integrity, authorization, isolation, replay, or secret defect.
- The packaged application exits without residual external processes.

## 10. P5 — Documentation And Release Reconciliation

Status: Complete for the current build. This reconciliation pass updates the completion index, C2/G3/H1 status headers, finalization checklist, Gate commands, and MCP runbook. Historical baseline sections remain labeled as audit history.

### 10.1 Required updates

- Change the completion plan from `Proposed` to the actual final state.
- Reconcile every unchecked Integration plan item with:
  - an automated test;
  - validated real evidence;
  - or an explicit accepted ADR that removes or changes the requirement.
- Update test counts, supported dependency versions, and environment setup.
- Document minimal install, diagnosis, recovery, and evidence commands for each real dependency.
- Record the supported Personal Build environment and known limitations.
- Run final acceptance from:
  - empty user data;
  - a supported older schema;
  - a configured real-dependency state.

### 10.2 P5 exit criteria

- No authoritative plan claims a completed capability is unfinished.
- No unfinished capability is marked complete.
- Requirement-to-test/evidence traceability is mechanically reviewable.
- Repository status, Gate artifacts, and release notes identify the same build and schema.

Current result: all four criteria are satisfied for application `0.1.0`, state schema `14`; the release commit is recorded in Git history alongside this reconciliation.

## 11. Test Matrix

| Mode | Purpose | External activation | Default CI |
| --- | --- | --- | --- |
| Unit/contract | Pure behavior, schema, policy, persistence | None | Required |
| Fixture desktop | Complete UI/IPC/Host paths | Fixture adapters only | Required |
| Unavailable/failure | Degradation and recovery | Explicit failure injection | Required |
| Real OCR | Local Paddle/Ovis execution | Explicit local runtime | Optional/local gate |
| Real Office | User-supplied Skill and runner | Explicit external runner | Personal Build gate |
| Real MCP | Pinned adapter and real server | Explicit connection | Personal Build gate |
| Real Delegation | Provider-backed child sessions | Explicit Provider calls | Personal Build gate |
| Packaged lifecycle | Process, restart, backup, external edit | Bounded packaged app | Personal Build gate |

Fixture success never closes a real-dependency requirement.

## 12. Commit And Review Strategy

Recommended commit sequence:

1. `fix: isolate parser runtime and e2e environments`
2. `test: add strict release gate semantics`
3. `feat: productize desktop integration contexts`
4. `feat: complete real extension audit workflow`
5. `test: close real office and mcp integration gate`
6. `feat: execute provider-backed sub-agent sessions`
7. `feat: adopt provenance-tracked sub-agent outputs`
8. `test: close personal build hardening gate`
9. `docs: reconcile personal build acceptance status`

Review rules:

- IPC and schema changes are reviewed separately from large UI changes.
- A persistence schema change includes deterministic migration and rollback coverage.
- Every stage starts and ends from a clean supported state.
- Real third-party packages, model weights, credentials, Project materials, and raw evidence never enter Git.
- Fixture adapters are injectable dependencies and are never production defaults.
- Authorization, data ownership, process ownership, or automatic behavior changes require an ADR update before implementation continues.

## 13. Initial Work Package

The first implementation package is limited to P0:

1. Implement the shared parser Python resolver.
2. Update Canonical Parse tests to use the resolver.
3. Add Playwright fixture/real environment allowlists.
4. Split ordinary and real-dependency E2E commands.
5. Make all ordinary Electron E2E pass.
6. Add strict `--require-pass` Gate behavior.
7. Update baseline test counts and runtime instructions.

This work package must be completed before Integration UI refactoring begins. It establishes the regression baseline required to judge every later change.

## 14. Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| User environment leaks into tests | False failures or accidental external activation | Child-process environment allowlists |
| Fixture paths remain visible in production | Mock success and unusable UX | Test-only injection and production static scan |
| Office package/runtime differs from fixture | C2 remains blocked | Validate complete external package early in P2 |
| MCP server schemas vary | Hardcoded UI fails | Generic schema-driven configuration and execution |
| Child sessions bypass Host policy | Authorization or data-integrity defect | Host-owned capabilities, scheduler, staging, and commit |
| Delegation context grows unbounded | Cost and scope leakage | Bounded references and minimal Capability Sets |
| Evidence can be spoofed | False Gate pass | Typed validators and dedicated runners |
| H1 is delayed by external coordination | Final release blocked | Prepare external dependencies during P1/P3 |
| Documentation drifts again | Incorrect completion claims | Update plans as part of each stage exit gate |

## 15. Final Handoff Checklist

- [x] P0 test/runtime baseline passes.
- [x] P1 production Integration paths contain no fixture defaults.
- [x] P2 Integration Gate passes with real Office/OCR/MCP evidence.
- [x] P3 real Provider-backed Delegation and Output adoption pass.
- [x] P4 Personal Build Gate passes with packaged lifecycle evidence.
- [x] P5 documentation and requirement traceability are current for the current build.
- [x] `pnpm verify` passes from a clean supported checkout.
- [x] Real evidence exists only outside the repository.
- [x] The final packaged app performs no eager external activation.
- [x] App shutdown leaves no child or external process running.
