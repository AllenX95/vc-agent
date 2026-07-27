param(
  [string]$PythonVersion = "3.12.2",
  [string]$Destination = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $repositoryRoot "packaging\parser-runtime"
}
$Destination = [System.IO.Path]::GetFullPath($Destination)
$packagingRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "packaging"))
if (-not ($Destination -eq $packagingRoot -or $Destination.StartsWith($packagingRoot + [System.IO.Path]::DirectorySeparatorChar))) {
  throw "Parser runtime destination must remain under the repository packaging directory."
}

$pythonMinor = ($PythonVersion -split "\.")[0..1] -join ""
$embeddedPython = Join-Path $Destination "python.exe"
$manifestPath = Join-Path $Destination "runtime-manifest.json"
$requirements = Join-Path $repositoryRoot "apps\utility-worker\requirements.txt"

function Test-ParserRuntime {
  if (-not (Test-Path -LiteralPath $embeddedPython)) {
    return $false
  }
  & $embeddedPython -c "import fitz, docx, pptx, openpyxl, yaml" 2>$null
  return $LASTEXITCODE -eq 0
}

function Get-Sha256Hex([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
      $sha256.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Write-ParserManifest {
  $manifest = [ordered]@{
    schemaVersion = 1
    kind = "vc-agent-parser-runtime"
    pythonVersion = $PythonVersion
    architecture = "x64"
    requirementsSha256 = (Get-Sha256Hex $requirements)
    packages = @("PyMuPDF==1.28.0", "python-docx==1.2.0", "python-pptx==1.0.2", "openpyxl==3.1.5", "PyYAML==6.0.2")
  }
  $json = $manifest | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

if (-not $Force -and (Test-ParserRuntime)) {
  Write-ParserManifest
  Write-Output "Parser runtime is ready: $Destination"
  exit 0
}

if (Test-Path -LiteralPath $Destination) {
  $resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
  if (-not $resolvedDestination.StartsWith($packagingRoot + [System.IO.Path]::DirectorySeparatorChar)) {
    throw "Refusing to replace parser runtime outside the packaging directory."
  }
  Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vc-agent-parser-runtime-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
  $archivePath = Join-Path $temporaryRoot "python-embed.zip"
  $downloadUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
  Write-Output "Downloading official Python $PythonVersion embeddable runtime..."
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
  Expand-Archive -LiteralPath $archivePath -DestinationPath $Destination

  $pathFile = Join-Path $Destination ("python" + $pythonMinor + "._pth")
  if (-not (Test-Path -LiteralPath $pathFile)) {
    throw "Python embeddable path configuration is missing: $pathFile"
  }
  @(
    ("python" + $pythonMinor + ".zip"),
    ".",
    "Lib\site-packages",
    "import site"
  ) | Set-Content -LiteralPath $pathFile -Encoding ascii

  $sitePackages = Join-Path $Destination "Lib\site-packages"
  New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null

  $hostPython = (Get-Command python -ErrorAction Stop).Source
  $hostVersion = (& $hostPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
  $requiredMinor = (($PythonVersion -split "\.")[0..1] -join ".")
  if ($hostVersion -ne $requiredMinor) {
    throw "Preparing Python $PythonVersion wheels requires a host Python $requiredMinor interpreter; found $hostVersion."
  }

  Write-Output "Installing bounded parser dependencies..."
  & $hostPython -m pip install --disable-pip-version-check --no-compile --only-binary=:all: --target $sitePackages -r $requirements
  if ($LASTEXITCODE -ne 0) {
    throw "Parser dependency installation failed."
  }

  & $embeddedPython -c "import fitz, docx, pptx, openpyxl, yaml; print('parser runtime imports passed')"
  if ($LASTEXITCODE -ne 0) {
    throw "Prepared parser runtime failed its import check."
  }

  Write-ParserManifest
  Write-Output "Parser runtime prepared: $Destination"
}
finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
