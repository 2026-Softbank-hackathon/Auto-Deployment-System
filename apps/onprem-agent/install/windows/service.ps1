# Manages the per-user logon task that keeps the Camellia on-prem agent running.
# Like the macOS LaunchAgent, it runs as the logged-in user (Docker Desktop runs in that session)
# and needs no administrator rights.
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the system code page.
param([string]$Action)
$ErrorActionPreference = 'Stop'

$TaskName = 'Camellia On-Prem Agent'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Camellia\onprem-agent'
$RunScript = Join-Path $InstallRoot 'bin\camellia-onprem-agent-run.ps1'
$CredentialPath = Join-Path $InstallRoot 'credentials.json'
$MainScript = Join-Path $InstallRoot 'lib\main.js'
$LogRoot = if ($env:CAMELLIA_AGENT_LOG_ROOT) { $env:CAMELLIA_AGENT_LOG_ROOT } else { Join-Path $env:LOCALAPPDATA 'Camellia\Logs' }

function Get-AgentTask {
  Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
}

function Get-AgentProcesses {
  # node processes running this install's main.js (the logon task does not always end its children)
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($MainScript) -and -not $_.CommandLine.Contains('--register-only') }
}

function Stop-Agent {
  $task = Get-AgentTask
  if ($task) { Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' }
  foreach ($process in @(Get-AgentProcesses)) {
    # /T also ends the cloudflared processes the agent started
    & taskkill.exe /PID $process.ProcessId /T /F *> $null
  }
}

function Start-Agent {
  if (-not (Test-Path -LiteralPath $RunScript)) {
    [Console]::Error.WriteLine('The agent is not installed. Run install.ps1 first.')
    exit 1
  }
  if (-not (Test-Path -LiteralPath $CredentialPath)) {
    [Console]::Error.WriteLine('The agent is not registered yet. Run "camellia-onprem-agent register" with a one-time token first.')
    exit 1
  }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScript`"" `
    -WorkingDirectory $InstallRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  if (-not @(Get-AgentProcesses)) { Start-ScheduledTask -TaskName $TaskName -TaskPath '\' }
  Write-Output "Agent started. Logs: $LogRoot"
}

switch ($Action) {
  'start' { Start-Agent }
  'stop' {
    Stop-Agent
    Write-Output 'Agent stopped.'
  }
  'restart' {
    Stop-Agent
    Start-Agent
  }
  'status' {
    $task = Get-AgentTask
    if (-not $task) {
      Write-Output 'Logon task: not registered'
    } else {
      $info = $task | Get-ScheduledTaskInfo
      Write-Output "Logon task: $($task.State) (last run $($info.LastRunTime))"
    }
    $processes = @(Get-AgentProcesses)
    if ($processes.Count -gt 0) {
      Write-Output "Agent process: running (PID $(($processes | ForEach-Object { $_.ProcessId }) -join ', '))"
    } else {
      Write-Output 'Agent process: not running'
    }
    Write-Output "Logs: $LogRoot"
  }
  default {
    [Console]::Error.WriteLine('Usage: service.ps1 {start|stop|restart|status}')
    exit 1
  }
}
