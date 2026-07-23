# R1 Project Worker Runtime Executable Specification

Date: 2026-07-22  
Status: Approved for implementation  
Parent: `2026-07-22-integration-slice-spec-index.md`  
Blocked by: R0 complete

## Outcome

One lazy Agent Worker is owned by each stable Project Identity and may host multiple isolated lazy Pi Thread Sessions. Each model-backed Unscoped Thread retains its own Worker. Agent Workers, Utility jobs, and Isolated jobs shut down predictably, remain bounded, and cannot corrupt Host-owned state when they fail.

## Non-goals

- No Sub-Agent Runs, child task tree, daemon, background replay, or per-Project concurrency setting.
- No shared model context, cross-Thread Pi session, implicit model merging, or Worker-owned product state.
- No arbitrary Extension loading beyond the effective approved Global Extension Revision.
- No new Output conflict merge algorithm; the existing Access Mode collision policy remains authoritative.

## Governing Decisions

ADR 0040, 0043, 0051, 0054, 0055, 0057, and 0058. Shared invariants from the Integration Slice Specification Index apply.

## Runtime Ownership Model

| Scope | Worker key | Session key | Working directory | Lazy start |
| --- | --- | --- | --- | --- |
| Project Thread | `project:<projectIdentity>` | `thread:<threadId>` | current registered Project path | First admitted model task |
| Unscoped Thread | `unscoped:<threadId>` | `thread:<threadId>` | app-owned unscoped work directory | First admitted model task |
| Dream isolated scope | existing isolated execution key until a later spec changes it | one stage session | app-owned Dream work directory | Explicit admitted stage |
| Extension Audit | defined by I6 | one audit session | staged audit directory | Explicit admitted audit |

Project paths MUST NOT be Worker identity. Moving a Project updates the locator used on the next dispatch without changing `project:<projectIdentity>`.

## Deep Modules And Interfaces

### `AgentRuntimeSupervisor`

This module replaces Thread-keyed process ownership. Callers know only how to dispatch, stop, retire, and inspect runtime ownership.

```ts
type WorkerOwner =
  | { kind: "project"; projectId: string; projectPath: string }
  | { kind: "unscoped"; threadId: string; workPath: string }
  | { kind: "isolated"; executionId: string; workPath: string };

interface AgentRuntimeSupervisor {
  execute(request: AgentExecutionRequest & { owner: WorkerOwner }): Promise<void>;
  stop(request: { threadId: string; turnId: string }): void;
  retire(owner: WorkerOwner): Promise<void>;
  shutdown(deadlineMs: number): Promise<RuntimeShutdownReport>;
  snapshot(): RuntimeOwnershipSnapshot;
}
```

Interface invariants:

- `execute` resolves Worker ownership from `owner`; callers cannot provide an arbitrary process key.
- A Project Worker multiplexes Thread Sessions by `threadId`; it never reuses one session object for another Thread.
- `stop` targets one Turn and MUST NOT terminate unrelated sessions unless the Worker crashes or global shutdown/revision changeover requires it.
- `shutdown` is idempotent, stops admission first, checkpoints active work, terminates process trees, and returns unresolved outcomes.

### Agent Worker session registry

The Agent Worker owns an internal registry keyed by Thread id. This is an internal seam, not Host-authoritative state.

```ts
interface WorkerSessionRegistry {
  execute(command: ThreadExecutionCommand): Promise<void>;
  stop(threadId: string, turnId: string): void;
  retire(threadId: string): Promise<void>;
  closeAll(): Promise<void>;
}
```

Each registry entry owns its Pi session, Physical Model Context metadata, active Turn id, resource snapshot revision, and last acknowledged sequence. A second Active Turn for the same Thread is rejected before Provider execution.

### `LocalJobSupervisor`

Utility Worker jobs and Isolated Job processes share one Host-owned supervision interface. The implementation may use two adapters because their process trust and lifecycle differ.

```ts
interface LocalJobSupervisor {
  submit(manifest: LocalJobManifest): Promise<LocalJobResult>;
  cancel(jobId: string): Promise<JobCancellationResult>;
  shutdown(deadlineMs: number): Promise<JobShutdownReport>;
  snapshot(): LocalJobRuntimeSnapshot;
}
```

The module owns bounded admission, staged inputs/results, output limits, timeout, process-tree termination, sanitized logs, and final-result validation. Callers never spawn child processes directly.

## Required Behavior

| Requirement | Behavior |
| --- | --- |
| R1-REQ-001 | Creating, opening, browsing, or restoring a Project or Thread MUST start no Agent Worker. |
| R1-REQ-002 | The first admitted Project execution MUST start one Worker keyed by stable Project Identity. |
| R1-REQ-003 | Concurrent Project Threads MUST use separate Pi sessions and Physical Model Contexts inside the same Worker. |
| R1-REQ-004 | A second execution for the same Thread MUST be rejected or queued by R0 before Worker dispatch. |
| R1-REQ-005 | Every model-backed Unscoped Thread MUST use its own Worker and receive no Project path, Project capability, attachment, provider authorization, or Project resource snapshot. |
| R1-REQ-006 | Project move recovery MUST preserve Worker ownership by identity; identity collision MUST block dispatch until User classification. |
| R1-REQ-007 | Worker crash MUST interrupt every active Turn hosted by that Worker, release scheduler leases, preserve checkpoints, and leave other Workers and Host state usable. |
| R1-REQ-008 | Utility or Isolated Job crash MUST preserve Host, Agent Workers, prior parse, prior Output, Source files, and validated staged results. |
| R1-REQ-009 | Stop MUST target one Turn. Project sibling Threads continue unless process loss makes their outcome unknown/interrupted. |
| R1-REQ-010 | App shutdown MUST close admission, checkpoint active Turns, cancel jobs, terminate all process trees within a bounded deadline, and perform no replay. |
| R1-REQ-011 | Same-target writes MUST stage and validate before the existing Standard/Full Access collision policy decides final replacement. |
| R1-REQ-012 | Worker commands and events MUST carry owner key, Thread id, Turn id, correlation id, worker revision, and sequence sufficient for stale-event rejection. |
| R1-REQ-013 | Effective Global Extension Revision and Runtime Resource Snapshot MUST be frozen at Worker/session creation boundaries defined by I1/I6. |
| R1-REQ-014 | Worker and local-job counts, ownership kind, duration, crash count, and cancellation outcome MUST be locally observable without content telemetry. |

## Dispatch State Machine

```text
dormant
  -> starting (first admitted execution)
  -> ready
  -> executing one or more distinct Thread sessions
  -> ready (all Turns terminal)
  -> retiring (idle policy, revision changeover, shutdown)
  -> terminated

starting/executing/retiring
  -> crashed
  -> reconcile active Turn checkpoints and scheduler leases
  -> dormant
```

Thread session state is independent inside a Project Worker:

```text
absent -> loading -> idle -> active -> idle -> retired
                    active -> interrupted | failed -> idle/retired
```

No transition from restart, crash reconciliation, or `dormant` automatically enters `starting`.

## Contracts And Persistence

Add versioned worker owner and session identifiers to WorkerCommand/WorkerEvent. Host persistence records only ownership coordination and Physical Context references; Pi session internals remain behind the Pi Adapter.

Required durable additions:

- `worker_runtime_checkpoints`: owner key, worker revision, effective Extension revision, lifecycle state, timestamps; never treated as proof that a process still exists after restart.
- Physical Context records remain keyed by Thread and gain the owner key/revision needed to reject mismatched session reuse.
- In-flight checkpoints remain per Turn and are reconciled to Interrupted Turn on startup.

Migration MUST derive Project owner keys only from stored stable Project Identity. Missing or colliding identity enters a visible blocked state; migration MUST NOT derive identity from folder content.

## Shutdown And Crash Reconciliation

Shutdown order:

1. Set Host `shuttingDown`; reject new scheduler and job admissions.
2. Persist latest bounded Turn checkpoints.
3. Send targeted stop to active sessions and cancel Utility/Isolated jobs.
4. Wait for acknowledgements within the configured deadline.
5. Terminate remaining child process trees.
6. Mark unresolved dispatched external writes as Unknown Tool Outcome.
7. Close stores only after terminal/checkpoint writes complete.

On startup, every persisted Worker record is considered non-running. Stale runtime leases are cleared by R0; checkpoints without terminal events become Interrupted Turns. No process is recreated.

## UI And Diagnostics

- Thread UI continues to show per-Turn status; it does not expose process topology in the primary workflow.
- Settings Runtime shows Project Workers, Unscoped Workers, active sessions, local jobs, crashes, and last bounded shutdown result.
- Environment Doctor validates Worker executable, Utility Worker, Isolated Job launch, process-tree termination support, writable staging directories, and Pi Adapter compatibility without starting Pi or running a real provider request.
- Project Identity collision remains a blocking User decision using existing Moved Project / Project Copy language.

## Failure Codes

`WORKER_OWNER_UNRESOLVED`, `PROJECT_IDENTITY_COLLISION`, `WORKER_REVISION_MISMATCH`, `THREAD_SESSION_ALREADY_ACTIVE`, `AGENT_WORKER_CRASHED`, `UTILITY_JOB_CRASHED`, `ISOLATED_JOB_CRASHED`, `JOB_TIMEOUT`, `JOB_CANCEL_INCOMPLETE`, `RUNTIME_SHUTDOWN_INCOMPLETE`, and `UNKNOWN_TOOL_OUTCOME`.

Failures MUST identify scope and recovery action without secret, command-line credential, raw prompt, or remote response bodies.

## Test Traceability

| Test | Requirements | Observable assertion |
| --- | --- | --- |
| R1-T-001 Lazy Project activation | 001, 002 | Browse creates zero Workers; first admitted Turn creates one identity-keyed Worker. |
| R1-T-002 Two Threads, one Project | 003, 004, 012 | Two concurrent Threads share PID/owner but have different sessions and contexts. |
| R1-T-003 Two Projects | 002, 012 | Concurrent Projects use distinct Workers and no cross-project events. |
| R1-T-004 Unscoped isolation | 005 | Separate PIDs and resource snapshots contain no Project authority. |
| R1-T-005 Move and collision | 006 | Move preserves owner key; copy blocks until classification. |
| R1-T-006 Targeted stop | 009 | One Thread interrupts while sibling Project Thread completes. |
| R1-T-007 Project Worker crash | 007 | Hosted Turns interrupt; other Worker completes; leases release. |
| R1-T-008 Utility/Isolated crash | 008 | Earlier artifacts remain valid and Host stays responsive. |
| R1-T-009 Process-tree cancellation | 008, 010 | Grandchild fixture exits within deadline on cancel/shutdown. |
| R1-T-010 Same-target collision | 011 | Standard confirms; Full executes visibly; staged validation precedes replace. |
| R1-T-011 Restart | 010 | Checkpoints reconcile; zero Worker/Provider starts until explicit work. |
| R1-T-012 Telemetry/Doctor | 014 | Counts and sanitized failures update; diagnostic causes no Pi activity. |
| R1-T-013 Migration | 012, 013 | Older state migrates atomically; mismatched owner/revision cannot load. |

## Implementation Order

1. Introduce owner/session contracts and a supervisor interface test with in-memory process adapters.
2. Refactor Agent Worker into a multi-session registry without changing Host worker ownership yet.
3. Switch Host supervision to stable Project and Unscoped owner keys.
4. Add targeted stop, worker-crash fan-out reconciliation, and telemetry.
5. Deepen Utility and Isolated process supervision behind `LocalJobSupervisor`.
6. Add shutdown ordering, process-tree tests, persistence migration, and full E2E matrix.

## Definition Of Done

- R1-REQ-001 through R1-REQ-014 pass through tests at the supervisor and desktop seams.
- Existing R0 queue, Reflection, Dream, Output, Project Identity, migration, and restart tests remain green.
- No production process spawn exists outside AgentRuntimeSupervisor, Utility Worker bootstrap, or LocalJobSupervisor adapters.
- The parent plan R1 checklist is fully checked with links to test evidence.

## Decision Gate

Do not begin I1, I2, I5, or I6 if Project Threads still require one Worker per Thread, if Unscoped resource snapshots can contain Project authority, or if child process trees cannot be terminated predictably on Windows.
