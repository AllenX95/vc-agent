# VC Agent

[中文版 README](./README.md)

VC Agent is a local-first desktop Agent for single-user venture-capital work. It uses Electron as the desktop shell and brings Projects, Threads, project materials, evidence-oriented analysis, investment reflection, and long-term investment learning into one inspectable and recoverable local workflow.

The current project is a Personal Build for one User. It is not a multi-user SaaS product or a general-purpose chat client.

## Product model

- **Project**: a local folder representing an investment opportunity, diligence effort, or related body of work.
- **Project Thread**: an independent conversation belonging to one Project. It may access authorized Project State, but it does not share model context with other Threads.
- **Unscoped Thread**: an independent conversation without a Project. It has no implicit access to Project files or Project State.
- **Project State**: material inventory, Canonical Parse artifacts, Project Context, Project Memory, Outputs, and related metadata.
- **Long-term Memory**: user-confirmed, de-identified cross-project investment learning.

## Core capabilities

| Capability | Description |
| --- | --- |
| Projects and Threads | Open local Projects, create Project / Unscoped Threads, maintain independent context, and rename a Thread from the conversation header. |
| Materials and evidence | Inventory project files and, on demand, parse PDF, DOCX, PPTX, XLSX, and text into source-referenced Canonical Parse and bounded retrieval results. |
| File downloads and Outputs | Save an explicitly requested public HTTP(S) file into the authorized Output Location; a complete ArXiv paper uses the Host-owned HTML-first archive for HTML/PDF, Markdown, and metadata; bounded batch text writes inside the folder use one G3 approval in Standard Access. |
| Model execution | Pi SDK-based streaming conversations, Model Profiles, Provider changes, context budgets, Thread Compaction, execution queues, and visible failure states. |
| Investment workflows | Ordinary VC dialogue, public research, Investment Reflection, Investment Retrospective, and explicitly authorized Sub-Agent work. |
| Memory and review | Project Context, Project Memory, Long-term Memory, Memory Evolution, and two-stage Dream review; durable writes require separate User confirmation. |
| Optional integrations | Skills Directory, Office workflows, MCP, Academic Research, and local Page Recovery / OCR. External runtimes are connected through explicit configuration and Host boundaries. |
| Local reliability | SQLite state, Thread Trajectory, versioned migrations, recovery mode, Personal Cognition Backup, and inspectable local outputs. |

## Design principles

1. **Local-first**: Project content, Outputs, parsed artifacts, Memory, and Thread trajectories remain local; the application does not depend on a cloud workspace sync layer.
2. **Host-owned boundaries**: Electron Main / Host owns state, authorization, scope, and lifecycle; the Agent Worker executes only explicitly submitted model work.
3. **Lazy activation**: Launching the application, opening a Project, or creating a Thread does not automatically start a model Worker or Provider request.
4. **Scope isolation**: Project Threads and Unscoped Threads have different access boundaries for files, materials, Context, and Memory.
5. **Explicit intent and review**: External writes, deletion, permission expansion, Reflection, Dream, and durable Memory changes retain visible User decision points.

## Quick start

### Requirements

- Windows x64 is the primary development and packaging target.
- Node.js `>= 24`.
- pnpm `10.10.0` (pinned through the repository `packageManager` field).
- Optional local parser, OCR, Office, or real MCP integrations require their own external runtimes; they are not required for the basic installation.

### Install dependencies

From the repository root:

```powershell
pnpm install
```

### Start the development application

The following command builds the Workers and Desktop, then starts Electron:

```powershell
pnpm dev
```

On Windows, you can also run:

```powershell
.\start-dev.cmd
```

For the first run:

1. Open **Settings**, create at least one Model Profile, and configure the relevant Provider credential.
2. Open a local Project or create an Unscoped Thread.
3. Submit a question in a Thread. The Agent Worker and model session start only when model-backed work is submitted.
4. From a Project, inspect materials, Context, and Outputs, then start Reflection or Dream review when appropriate.

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build the Agent Worker, Utility Worker, and Desktop. |
| `pnpm typecheck` | Run TypeScript type checking across the workspace. |
| `pnpm test` | Run Vitest unit and contract tests. |
| `pnpm test:e2e` | Build and run Playwright Electron tests, excluding `@real` tests. |
| `pnpm verify` | Run type checking, unit tests, and E2E tests. |
| `pnpm package:win` | Prepare the parser runtime and create a Windows x64 NSIS installer. |
| `pnpm package:win:dir` | Build an unpacked Windows x64 package for inspection. |

Real external dependency checks use separate commands such as `pnpm mcp:compat`, `pnpm office:compat`, `pnpm academic-research:compat`, and `pnpm h1:packaged`. They require extra environment variables or external evidence and are not part of the normal development startup flow.

## Local data and privacy

On Windows, the default User data root is:

```text
%LOCALAPPDATA%\vc-agent
```

Typical contents include:

```text
state.db        # SQLite application state and indexes
threads/        # Thread Trajectory
memory/         # Long-term Memory, Project Memory, Dream, and related state
skills/         # Imported and active Skills
integrations/   # Office, MCP, Extension, and related integration state
```

`VC_AGENT_USER_DATA_DIR` can override the User data location. Project files, Context, Memory, Outputs, and parse artifacts remain ordinary local files for inspection, backup, and recovery. Provider credentials are stored through operating-system protection; application state keeps references and non-sensitive metadata rather than raw credentials.

The application provides **Standard Access** and **Full Access** modes. Full Access reduces subsequent tool confirmations, but it does not bypass product-level review for Reflection, Dream, Memory commits, or Thread scope changes. The User remains responsible for securing the operating-system account, device, and backup destinations.

In Standard Access, downloads, local ArXiv archiving, and bounded folder writes show their scoped source, destination, and file manifest before execution. Project text search reuses scoped Pi `grep`/`find`/`read` tools; no general project-command entry point is exposed.

## Repository structure

```text
apps/
  desktop/          Electron Main, Preload, and Renderer
  agent-worker/     Agent Worker runtime
  utility-worker/   Parser, OCR, and local job runtime
packages/
  contracts/        IPC, events, and domain data contracts
  persistence/      SQLite state storage and migrations
  host-services/    Host workflows, Memory, Project, and integration services
  capabilities/     Host-registered capabilities
  pi-adapter/       Pi SDK / MCP adapter boundary
tests/              Unit, contract, architecture, and Electron E2E tests
docs/               ADRs, runtime, and compatibility notes
```

## Documentation

- [Windows packaging](./docs/windows-packaging.md)
- [Local OCR / Page Recovery](./docs/local-ocr-runtime.md)
- [Local MCP compatibility](./docs/local-mcp-compatibility.md)
- [Architecture Decision Records (ADRs)](./docs/adr/)
- [Project context and terminology](./CONTEXT.md)

## Status

The project is under active development. Some Office, OCR, MCP, Provider, and external Skill capabilities require additional runtimes or User configuration. Tests that use real external systems are marked separately and require sanitized evidence; repository fixtures are for development and automation only and do not imply that a real dependency is configured.
