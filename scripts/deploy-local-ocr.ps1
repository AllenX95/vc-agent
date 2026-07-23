param(
  [ValidateSet("Cpu", "Nvidia")]
  [string]$Profile = "Nvidia",
  [string]$RuntimeRoot = $(Join-Path $env:LOCALAPPDATA "vc-agent\runtimes\ocr"),
  [string]$PythonExe = "C:\Program Files\Python312\python.exe",
  [switch]$SkipValidation
)

$ErrorActionPreference = "Stop"
$runtimePath = [System.IO.Path]::GetFullPath($RuntimeRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$paddleVenv = Join-Path $runtimePath "paddle-venv"
$ovisVenv = Join-Path $runtimePath "ovis-venv"
$paddlePython = Join-Path $paddleVenv "Scripts\python.exe"
$ovisPython = Join-Path $ovisVenv "Scripts\python.exe"
$modelRoot = Join-Path $runtimePath "models\ovisocr2"
$ovisRevision = "65c619d374b55d4152e85150fc1b003700bc1f0c"

New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
foreach ($venv in @($paddleVenv, $ovisVenv)) {
  $candidate = Join-Path $venv "Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $candidate)) {
    & $PythonExe -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Failed to create OCR virtual environment at $venv." }
  }
}
foreach ($python in @($paddlePython, $ovisPython)) {
  & $python -m pip install --upgrade pip setuptools wheel
  if ($LASTEXITCODE -ne 0) { throw "Failed to bootstrap OCR virtual environment: $python" }
}

if ($Profile -eq "Nvidia") {
  & $ovisPython -m pip install "torch==2.13.0" "torchvision==0.28.0" --index-url https://download.pytorch.org/whl/cu130
  if ($LASTEXITCODE -ne 0) { throw "Failed to install PyTorch CUDA runtime." }
  & $paddlePython -m pip install "paddlepaddle-gpu==3.3.1" --index-url https://www.paddlepaddle.org.cn/packages/stable/cu130/
  if ($LASTEXITCODE -ne 0) { throw "Failed to install PaddlePaddle CUDA runtime." }
  $devices = @("cpu", "cuda")
} else {
  & $ovisPython -m pip install "torch==2.13.0" "torchvision==0.28.0" --index-url https://download.pytorch.org/whl/cpu
  if ($LASTEXITCODE -ne 0) { throw "Failed to install PyTorch CPU runtime." }
  & $paddlePython -m pip install "paddlepaddle==3.3.1" --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/
  if ($LASTEXITCODE -ne 0) { throw "Failed to install PaddlePaddle CPU runtime." }
  $devices = @("cpu")
}

& $paddlePython -m pip install "paddleocr==3.7.0" "PyMuPDF==1.28.0" "Pillow>=11.0,<13"
if ($LASTEXITCODE -ne 0) { throw "Failed to install PaddleOCR application dependencies." }
& $ovisPython -m pip install "transformers==5.14.1" "huggingface-hub==1.24.0" "PyMuPDF==1.28.0" "Pillow>=11.0,<13" "safetensors>=0.7,<0.9"
if ($LASTEXITCODE -ne 0) { throw "Failed to install OvisOCR2 application dependencies." }
New-Item -ItemType Directory -Force -Path $modelRoot | Out-Null
$download = @"
from huggingface_hub import snapshot_download
from pathlib import Path
root = Path(r'''$modelRoot''')
snapshot_download(repo_id='ATH-MaaS/OvisOCR2', revision='$ovisRevision', local_dir=root)
(root / 'vc-agent-revision.txt').write_text('$ovisRevision\n', encoding='utf-8')
"@
$download | & $ovisPython -
if ($LASTEXITCODE -ne 0) { throw "Failed to download the pinned OvisOCR2 snapshot." }

[Environment]::SetEnvironmentVariable("VC_AGENT_OCR_RUNTIME_ROOT", $runtimePath, "User")
[Environment]::SetEnvironmentVariable("VC_AGENT_OCR_PYTHON", $null, "User")
[Environment]::SetEnvironmentVariable("VC_AGENT_OCR_DEVICE", "auto", "User")
$env:VC_AGENT_OCR_RUNTIME_ROOT = $runtimePath
$env:VC_AGENT_OCR_DEVICE = "auto"

if (-not $SkipValidation) {
  $validationScript = Join-Path $repoRoot "scripts\validate-local-ocr.py"
  $workerScript = Join-Path $repoRoot "apps\utility-worker\src\ocr_runtime.py"
  & $paddlePython $validationScript --runtime-root $runtimePath --worker-script $workerScript --stage paddle --devices $devices
  if ($LASTEXITCODE -ne 0) { throw "PaddleOCR local validation failed." }
  & $ovisPython $validationScript --runtime-root $runtimePath --worker-script $workerScript --stage ovis --devices $devices
  if ($LASTEXITCODE -ne 0) { throw "OvisOCR2 local validation failed." }
}

$manifest = [ordered]@{
  schemaVersion = 1
  revision = "local-ocr-paddle-3.7.0-ovis-$($ovisRevision.Substring(0, 12))"
  validatedDevices = $devices
  components = [ordered]@{
    paddle = [ordered]@{ id = "paddleocr-local"; name = "PaddleOCR"; version = "3.7.0" }
    ovis = [ordered]@{ id = "ovisocr2-local"; name = "OvisOCR2"; version = $ovisRevision }
  }
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runtimePath "runtime-manifest.json") -Encoding utf8

$paddleReportPath = Join-Path $runtimePath "validation\validation-paddle.json"
$ovisReportPath = Join-Path $runtimePath "validation\validation-ovis.json"
if ((Test-Path -LiteralPath $paddleReportPath) -and (Test-Path -LiteralPath $ovisReportPath)) {
  $evidencePath = Join-Path $runtimePath "validation\local-ocr-evidence.json"
  $evidence = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString("o")
    runtimeRevision = $manifest.revision
    validatedDevices = $devices
    paddle = Get-Content -LiteralPath $paddleReportPath -Raw | ConvertFrom-Json
    ovis = Get-Content -LiteralPath $ovisReportPath -Raw | ConvertFrom-Json
  }
  $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  [Environment]::SetEnvironmentVariable("VC_AGENT_REAL_OCR", "1", "User")
  [Environment]::SetEnvironmentVariable("VC_AGENT_REAL_OCR_EVIDENCE", $evidencePath, "User")
}

Write-Output "OCR runtime deployed to $runtimePath"
Write-Output "Restart vc-agent so it inherits the local OCR runtime and evidence settings."
