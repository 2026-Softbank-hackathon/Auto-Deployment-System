# Keeps the Camellia on-prem agent running for the logged-in user (started by the logon task).
# Windows equivalent of launchd KeepAlive: restarts the agent when it exits, for example
# while Docker Desktop is still starting after logon.
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the system code page.
$ErrorActionPreference = 'Stop'

$InstallRoot = Split-Path -Parent $PSScriptRoot
$LogRoot = if ($env:CAMELLIA_AGENT_LOG_ROOT) { $env:CAMELLIA_AGENT_LOG_ROOT } else { Join-Path $env:LOCALAPPDATA 'Camellia\Logs' }
$MainScript = Join-Path $InstallRoot 'lib\main.js'
$OutLog = Join-Path $LogRoot 'agent.log'
$ErrLog = Join-Path $LogRoot 'agent-error.log'
$RestartDelaySeconds = 10
$MaxLogBytes = 10MB

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

while ($true) {
  foreach ($log in @($OutLog, $ErrLog)) {
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt $MaxLogBytes) {
      Move-Item -LiteralPath $log -Destination "$log.1" -Force
    }
  }
  # cmd appends to the logs (Start-Process redirection would overwrite them on every restart).
  $command = "/d /s /c `"node `"$MainScript`" >> `"$OutLog`" 2>> `"$ErrLog`"`""
  # Wait for cmd only: -Wait would also wait for any cloudflared left behind by a crashed agent.
  $process = Start-Process -FilePath $env:ComSpec -ArgumentList $command -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru
  $process.WaitForExit()
  Start-Sleep -Seconds $RestartDelaySeconds
}
