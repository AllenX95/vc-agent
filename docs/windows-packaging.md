# Windows x64 Packaging

The Personal Build ships as a per-user NSIS installer. The default installer
contains Electron, the Desktop application, both Worker runtimes, the bundled
Pi/MCP adapter code, and a bounded Python parser runtime. Heavy OCR models,
Microsoft Office, User-supplied Skills, MCP servers, Extensions, credentials,
Projects, and user data remain outside the installer.

## Build

```powershell
pnpm package:win
```

The command:

1. Builds Desktop, Agent Worker, and Utility Worker artifacts.
2. Prepares an official Python embeddable x64 parser runtime with the pinned
   requirements in `apps/utility-worker/requirements.txt`.
3. Validates that all package inputs exist and that Agent Worker has no
   external workspace/Pi imports.
4. Builds `release/VC-Agent-Setup-0.1.0-x64.exe`.

`electron-builder.yml` deliberately points `electronDist` at the locally
installed Electron distribution. Do not remove this setting: without it,
electron-builder downloads the exact Electron archive and a slow or blocked
network can wait for its ten-minute request timeout.

To inspect the unpacked application without running NSIS compression:

```powershell
pnpm package:win:dir
pnpm test:e2e:packaged
```

To test the actual installer, installed executable, and uninstaller:

```powershell
pnpm test:e2e:installed
```

The installer smoke uses `release/installed-smoke`. It must not use
`test-results`, because Playwright clears its output directory before a run.

## Runtime Layout

```text
resources/
  app.asar
  workers/
    agent-worker/dist/
    utility-worker/dist/
  parser-runtime/
  THIRD_PARTY_NOTICES.txt
```

Workers are ordinary resource files rather than ASAR-only files. Utility Worker
passes `parser.py` and `ocr_runtime.py` to external Python processes, which
cannot read Electron's virtual ASAR paths.

User data remains under Electron's per-user `userData` directory. Uninstall
does not delete it.

## Optional External Capabilities

- OCR remains under `%LOCALAPPDATA%\vc-agent\runtimes\ocr` and is not included
  in the default installer.
- Microsoft Office and User-supplied Office Skills remain external.
- MCP servers remain user-configured; only the pinned adapter is bundled.
- Provider credentials remain OS-protected user data.

## Release Requirements

Internal unsigned builds use Electron's default icon until branded `.ico`
assets and a Windows code-signing certificate are supplied. Before any build
is distributed beyond the Personal Build:

1. Replace the placeholder third-party notices with a generated license
   inventory.
2. Add the approved Windows application icon.
3. Configure the code-signing certificate and timestamp service.
4. Run typecheck, unit/integration tests, packaged smoke, installed smoke, and
   the Personal Build release gates against the same build identity.
