# Downloads a pinned Camellia on-prem agent release for Windows x64, verifies its SHA-256 and installs it.
# Published as install-agent.ps1 next to install-agent.sh. Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-agent.ps1 v0.1.10
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the system code page.
param([string]$Version)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([string]$message) {
  [Console]::Error.WriteLine($message)
  exit 1
}

$Repository = '2026-Softbank-hackathon/Auto-Deployment-System'
if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
  Fail 'Specify the agent version as vMAJOR.MINOR.PATCH.'
}
if ($env:OS -ne 'Windows_NT') { Fail 'This installer is for Windows only.' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { Fail "Unsupported Windows architecture: $architecture (x64 only)" }

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$AssetName = "camellia-onprem-agent-$Version-windows-x64.zip"
$ReleaseUrl = "https://github.com/$Repository/releases/download/onprem-agent-$Version"
$DownloadRoot = Join-Path ([IO.Path]::GetTempPath()) ("camellia-onprem-agent-" + [Guid]::NewGuid().ToString('N'))
$ArchivePath = Join-Path $DownloadRoot $AssetName
$ChecksumPath = "$ArchivePath.sha256"
$ExtractRoot = Join-Path $DownloadRoot 'extracted'

New-Item -ItemType Directory -Force -Path $DownloadRoot | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/$AssetName" -OutFile $ArchivePath
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/$AssetName.sha256" -OutFile $ChecksumPath

  $expected = $null
  foreach ($line in Get-Content -LiteralPath $ChecksumPath) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1].TrimStart('*') -eq $AssetName) { $expected = $parts[0] }
  }
  if ($expected -notmatch '^[0-9a-fA-F]{64}$') { Fail 'Could not find a valid SHA-256 checksum.' }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash
  if ($actual -ne $expected) { Fail 'The agent release archive checksum does not match.' }

  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot -Force
  $BundleRoot = Join-Path $ExtractRoot 'camellia-onprem-agent'
  $versionFile = Join-Path $BundleRoot 'VERSION'
  $architectureFile = Join-Path $BundleRoot 'ARCHITECTURE'
  if (-not (Test-Path -LiteralPath $versionFile) -or (Get-Content -Raw -LiteralPath $versionFile).Trim() -ne $Version) {
    Fail 'The downloaded agent release version does not match the requested version.'
  }
  if (-not (Test-Path -LiteralPath $architectureFile) -or (Get-Content -Raw -LiteralPath $architectureFile).Trim() -ne 'x64') {
    Fail 'The downloaded agent release is not for Windows x64.'
  }
  $installScript = Join-Path $BundleRoot 'install\windows\install.ps1'
  if (-not (Test-Path -LiteralPath $installScript)) { Fail 'The agent release archive has no installer.' }

  & $installScript
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
  Remove-Item -LiteralPath $DownloadRoot -Recurse -Force -ErrorAction SilentlyContinue
}
