# I4 Local Page Recovery Executable Specification

Date: 2026-07-22  
Status: Approved for implementation  
Parent: `2026-07-22-integration-slice-spec-index.md`  
Blocked by: R1 and existing Canonical Parse

## Outcome

PDF parsing uses one fixed local page chain behind `material_parse`: preserve usable PyMuPDF native blocks, run ordinary PaddleOCR only for missing/unreliable pages, then run OvisOCR2 only for pages still missing, unreliable, or structurally insufficient. Every later failure preserves the best validated earlier representation.

## Non-goals

- No user-selectable OCR provider, PP-StructureV3, external OCR API, Provider call, Pi session, or model Profile.
- No eager model download/inference at launch or diagnostics and no replacement of Canonical Parse with parser-specific output.
- No claim that CPU availability implies acceptable throughput.

## Governing Decisions

ADR 0035, 0039, 0057, 0059, and Canonical Parse contracts.

## Deep Modules And Interfaces

### `PageRecoveryPipeline`

```ts
interface PageRecoveryPipeline {
  parse(request: MaterialParseRequest): Promise<CanonicalParseResult>;
  cancel(parseId: string): Promise<JobCancellationResult>;
  inspectAvailability(): PageRecoveryAvailability;
}
```

The module owns stage routing, page rendering, bounded job admission, quality assessment, best-result retention, parser-independent mapping, provenance, cancellation, and staged commit. Callers see one material parse operation and never select a stage.

### Internal stage adapters

`NativePdfAdapter`, `PaddleOcrAdapter`, and `OvisOcrAdapter` are internal seams with production Utility Worker adapters and deterministic fixture adapters. They return staged page candidates; none writes Canonical Parse directly.

## Deterministic Routing

Native page quality considers at minimum text presence, printable-character ratio, replacement/control characters, suspicious glyph repetition, text/image coverage, and extraction warnings. Paddle output quality adds confidence and usable reading text. Structural insufficiency for Ovis escalation considers tables/formulas/layout/visual regions/reading order using deterministic page signals and validated Paddle output, not an LLM call.

Thresholds and weights MUST be versioned in one `page_quality_policy` revision and recorded in parse provenance.

## Required Behavior

| Requirement | Behavior |
| --- | --- |
| I4-REQ-001 | PyMuPDF MUST be the first PDF parser/renderer and usable native blocks MUST remain available even when recovery runs. |
| I4-REQ-002 | PaddleOCR MUST receive only bounded rendered pages classified missing or unreliable by the versioned policy. |
| I4-REQ-003 | OvisOCR2 MUST receive only pages whose Paddle result is unavailable/unreliable or structurally insufficient. |
| I4-REQ-004 | Every stage MUST run locally through bounded Utility Worker jobs with pinned adapter/runtime/model revisions, declared resources, timeout, and cancellation. |
| I4-REQ-005 | Stage candidates MUST pass schema, page identity, bounds, truncation, repetition, confidence/quality, table/formula, and source-page validation before selection. |
| I4-REQ-006 | Selection MUST retain the best validated candidate per content class; later execution alone never makes a candidate preferred. |
| I4-REQ-007 | Canonical Parse MUST preserve parser-independent blocks, tables, geometry, images, warnings, stable page/source references, and candidate provenance. |
| I4-REQ-008 | Timeout, cancellation, malformed result, crash, or unavailable later stage MUST commit the best earlier usable result and visible warning. |
| I4-REQ-009 | Diagnostics MUST distinguish native parse warning, OCR unavailable, OCR failed, and complex parse unavailable. |
| I4-REQ-010 | External OCR and automatic alternate parser/provider fallback MUST remain disabled. |
| I4-REQ-011 | Dependency checks MUST NOT load weights, initialize inference, render project pages, start Pi, or contact a Provider. |
| I4-REQ-012 | External source change during parse MUST follow Parse Refresh Choice and MUST NOT commit a candidate against a mismatched source hash. |
| I4-REQ-013 | CPU/GPU path, pinned versions, last duration, page counts by stage, failures, and retained-result counts MUST be locally observable without page content telemetry. |

## Per-page State Machine

```text
native_candidate -> native_usable -> selected
native_candidate -> native_missing/unreliable -> paddle_pending
paddle_pending -> paddle_usable -> selected
paddle_pending -> paddle_unavailable/failed/unreliable/structurally_insufficient
  -> ovis_pending
ovis_pending -> ovis_validated -> selected_by_quality
ovis_pending -> unavailable/failed/invalid -> retain best native/paddle candidate
```

Material parse status becomes completed-with-warnings when any usable result exists; it becomes failed only when no required usable Canonical Parse can be produced.

## Job And Result Contracts

Each job manifest carries parse id, material id, source hash, page numbers, rendered input paths, adapter/policy revision, resource limits, staging destination, and cancellation token. Results carry page number, candidate blocks/tables/geometry, quality signals, warnings, timing, adapter/runtime/model revision, and output hash.

Rendered pages and raw model output are temporary. Validated Canonical Parse and compact provenance are durable Project artifacts. Job logs are sanitized and bounded.

## UI And Environment Doctor

- Material parse activity shows Native extraction, OCR recovery, Complex page recovery, pages completed/total, cancellation, and warnings.
- The final parse inspection identifies retained stage per page without presenting Ovis as a selectable Provider.
- Environment Doctor reports PyMuPDF, PaddleOCR, OvisOCR2, model weights, execution path, disk/resource readiness, and actionable install guidance. It performs metadata/file checks only.

## Failure Codes

`NATIVE_PARSE_WARNING`, `NATIVE_PARSE_FAILED`, `OCR_UNAVAILABLE`, `OCR_FAILED`, `OCR_RESULT_INVALID`, `COMPLEX_PARSE_UNAVAILABLE`, `COMPLEX_PARSE_FAILED`, `COMPLEX_PARSE_INVALID`, `PAGE_RECOVERY_TIMEOUT`, `PAGE_RECOVERY_CANCELLED`, `SOURCE_CHANGED_DURING_PARSE`, and `UTILITY_WORKER_CRASHED`.

## Test Traceability

| Test | Requirements | Assertion |
| --- | --- | --- |
| I4-T-001 Native text | 001, 007 | No OCR job; native references preserved. |
| I4-T-002 Scanned page | 002, 004 | Only scanned page enters Paddle; usable output selected. |
| I4-T-003 Mixed pages | 001, 002, 006 | Native pages unchanged; selected recovery is page-specific. |
| I4-T-004 Structural escalation | 003, 005, 006 | Complex fixture reaches Ovis; validated structure wins only by quality. |
| I4-T-005 Invalid Ovis | 005, 008, 009 | Repetition/truncation rejected; Paddle/native retained with warning. |
| I4-T-006 Missing dependencies | 008-011 | Clear unavailable codes, no fallback/Pi/network, earlier result committed. |
| I4-T-007 Timeout/cancel/crash | 004, 008 | Process tree terminates; Host survives; best candidate persists. |
| I4-T-008 Source change | 012 | Mismatched source hash cannot activate parse. |
| I4-T-009 Doctor/telemetry | 011, 013 | No inference on inspection; sanitized counters and path reported. |
| I4-T-010 Migration/reuse | 007 | Provenance migrates; unchanged source reuses parse without inference. |

## Implementation Order

1. Freeze quality policy and staged page candidate contracts with fixtures.
2. Refactor current PyMuPDF path behind `PageRecoveryPipeline` without OCR.
3. Add Paddle adapter, page routing, validation, and best-result retention.
4. Add Ovis adapter, structural escalation, deterministic decoding, and validation.
5. Add cancellation/crash containment, Doctor, telemetry, migration, and E2E.

## Definition Of Done And Decision Gate

All routing and best-result tests pass with pinned local adapters. Stop if implementing Ovis requires loading it in Electron Main/Agent Worker, using remote inference, or discarding usable earlier content.
