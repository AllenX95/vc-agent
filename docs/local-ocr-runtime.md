# Local OCR Runtime

vc-agent uses one fixed, local page-recovery order:

1. PyMuPDF native extraction.
2. PaddleOCR only when native text is missing or unreliable.
3. OvisOCR2 only when PaddleOCR is unavailable, unreliable, or structurally insufficient.

Later-stage failure never discards a usable earlier result. Model loading occurs only after an explicit parse command; availability inspection reads `runtime-manifest.json` and does not initialize inference.

## Windows deployment

Run from the repository root in PowerShell:

```powershell
.\scripts\deploy-local-ocr.ps1 -Profile Nvidia -RuntimeRoot E:\vc-agent-runtime\ocr
```

Use `-Profile Cpu` for a CPU-only installation. The NVIDIA profile installs and validates both CPU and CUDA paths. It creates isolated `paddle-venv` and `ovis-venv` environments because loading PaddlePaddle and PyTorch CUDA libraries into one Windows Python process can cause cuDNN DLL conflicts.

The deployment pins PaddleOCR 3.7.0, PaddlePaddle 3.3.1, PyTorch 2.13.0, Transformers 5.14.1, and OvisOCR2 revision `65c619d374b55d4152e85150fc1b003700bc1f0c`. Model weights and validation evidence remain outside Git.

## Runtime controls

- `VC_AGENT_OCR_RUNTIME_ROOT`: deployed runtime directory.
- `VC_AGENT_OCR_DEVICE`: `auto`, `cpu`, or `cuda`; `auto` prefers validated CUDA.
- `VC_AGENT_OVIS_MAX_NEW_TOKENS`: optional Ovis generation bound; default is 2048.
- `VC_AGENT_REAL_OCR_EVIDENCE`: redacted CPU/CUDA validation evidence used by the integration gate.

Restart vc-agent after deployment so it inherits the user-level environment variables. In Settings → Integrations, `Inspect availability` must show Native, Paddle, and Ovis as ready. `Run Page Recovery` accepts an inventoried PDF and does not expose a provider selector.

## Verification

The deployment script runs every engine twice on every selected device and requires non-empty, byte-identical repeated output. To exercise the complete Electron → Host IPC → Utility Worker → Paddle/Ovis process chain:

```powershell
$env:VC_AGENT_OCR_RUNTIME_ROOT = "E:\vc-agent-runtime\ocr"
pnpm build
pnpm exec playwright test tests/e2e/local-ocr.spec.ts
```

Ovis CPU execution is supported but is intended as a compatibility path, not a throughput claim. Generated Markdown is rejected or downgraded on token-limit, repetition, unbalanced table/formula, empty-output, timeout, or worker failure signals.
