param(
  [string]$Installer = ""
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
$installRoot = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot "installed-smoke"))
if (-not $installRoot.StartsWith($releaseRoot + [System.IO.Path]::DirectorySeparatorChar)) {
  throw "Installed smoke target escaped the release directory."
}
if ([string]::IsNullOrWhiteSpace($Installer)) {
  $Installer = Join-Path $releaseRoot "VC-Agent-Setup-0.1.0-x64.exe"
}
$Installer = [System.IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $Installer)) {
  throw "Installer is missing: $Installer"
}

$priorUninstaller = Join-Path $installRoot "Uninstall VC Agent.exe"
if (Test-Path -LiteralPath $priorUninstaller) {
  $prior = Start-Process -FilePath $priorUninstaller -ArgumentList @("/currentuser", "/S") -WindowStyle Hidden -Wait -PassThru
  if ($prior.ExitCode -ne 0) {
    throw "Prior smoke installation could not be removed: $($prior.ExitCode)"
  }
  Start-Sleep -Seconds 3
}
if (Test-Path -LiteralPath $installRoot) {
  throw "Smoke installation directory is not clean: $installRoot"
}

$installerProcess = Start-Process -FilePath $Installer -ArgumentList @("/S", ("/D=" + $installRoot)) -WindowStyle Hidden -Wait -PassThru
if ($installerProcess.ExitCode -ne 0) {
  throw "Installer failed: $($installerProcess.ExitCode)"
}

$application = Join-Path $installRoot "VC Agent.exe"
$uninstaller = Join-Path $installRoot "Uninstall VC Agent.exe"
try {
  for ($attempt = 0; $attempt -lt 20 -and (-not (Test-Path -LiteralPath $application) -or -not (Test-Path -LiteralPath $uninstaller)); $attempt += 1) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $application) -or -not (Test-Path -LiteralPath $uninstaller)) {
    throw "Installed application or uninstaller is missing."
  }

  $env:VC_AGENT_PACKAGED_EXE = $application
  & pnpm test:e2e:packaged
  if ($LASTEXITCODE -ne 0) {
    throw "Installed packaged smoke failed."
  }
}
finally {
  if (Test-Path -LiteralPath $uninstaller) {
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @("/currentuser", "/S") -WindowStyle Hidden -Wait -PassThru
    if ($uninstallProcess.ExitCode -ne 0) {
      throw "Uninstaller failed: $($uninstallProcess.ExitCode)"
    }
    Start-Sleep -Seconds 3
  }
}

if (Test-Path -LiteralPath $installRoot) {
  throw "Uninstaller left the installation directory behind."
}
Write-Output "Installed Windows package smoke passed and the test installation was removed."
