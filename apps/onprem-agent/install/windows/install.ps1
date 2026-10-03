# Installs the Camellia on-prem agent for the current Windows user from a release bundle or a local build.
# It does not start the agent: register it with a one-time token first, then run "start".
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the system code page.
$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  [Console]::Error.WriteLine($message)
  exit 1
}

function Test-NativeCommand([string]$file, [string[]]$arguments) {
  # PowerShell 5.1 turns native stderr into errors under 'Stop'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $file @arguments *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previous
  }
}

if ($env:OS -ne 'Windows_NT') { Fail 'This installer is for Windows only.' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { Fail "Unsupported Windows architecture: $architecture (x64 only)" }

$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ArchitectureFile = Join-Path $SourceRoot 'ARCHITECTURE'
if ((Test-Path -LiteralPath $ArchitectureFile) -and (Get-Content -Raw -LiteralPath $ArchitectureFile).Trim() -ne 'x64') {
  Fail 'This release bundle is not for Windows x64.'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js 20 or later is required.' }
if (-not (Test-NativeCommand 'node' @('-e', 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)'))) {
  Fail 'Node.js 20 or later is required.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'The docker CLI is required (Docker Desktop).' }
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) { Fail 'cloudflared is required (winget install --id Cloudflare.cloudflared).' }
if (-not (Test-NativeCommand 'docker' @('info'))) { Fail 'The Docker daemon is not available in this user session. Start Docker Desktop.' }
if (-not (Test-NativeCommand 'docker' @('compose', 'version'))) { Fail 'Docker Compose v2 is required.' }

$InstallRoot = Join-Path $env:LOCALAPPDATA 'Camellia\onprem-agent'
$LogRoot = if ($env:CAMELLIA_AGENT_LOG_ROOT) { $env:CAMELLIA_AGENT_LOG_ROOT } else { Join-Path $env:LOCALAPPDATA 'Camellia\Logs' }
$BinDir = Join-Path $InstallRoot 'bin'
$LibDir = Join-Path $InstallRoot 'lib'

if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'dist\main.js'))) {
  Fail 'The built agent files are missing. Use a release bundle or run pnpm build first.'
}

New-Item -ItemType Directory -Force -Path $BinDir, $LibDir, $LogRoot | Out-Null
Copy-Item -Path (Join-Path $SourceRoot 'dist\*') -Destination $LibDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'camellia-onprem-agent.cmd') -Destination (Join-Path $BinDir 'camellia-onprem-agent.cmd') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run-agent.ps1') -Destination (Join-Path $BinDir 'camellia-onprem-agent-run.ps1') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'service.ps1') -Destination (Join-Path $BinDir 'camellia-onprem-agent-service.ps1') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination (Join-Path $BinDir 'camellia-onprem-agent-uninstall.ps1') -Force

$launcher = Join-Path $BinDir 'camellia-onprem-agent.cmd'
Write-Output 'Installed the agent files.'
Write-Output 'Register it first with the one-time token from the console:'
Write-Output "  & `"$launcher`" register"
Write-Output 'Then start it (it also starts automatically when you log on):'
Write-Output "  & `"$launcher`" start"
