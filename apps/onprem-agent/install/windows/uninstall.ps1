# Removes the Camellia on-prem agent for the current Windows user.
# Deletes the local agent key, moves the install folder to the Recycle Bin and keeps the logs.
# The key is not revoked on the server.
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the system code page.
$ErrorActionPreference = 'Stop'

$TaskName = 'Camellia On-Prem Agent'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Camellia\onprem-agent'
$CredentialPath = Join-Path $InstallRoot 'credentials.json'
$ServiceScript = Join-Path $InstallRoot 'bin\camellia-onprem-agent-service.ps1'

if (Test-Path -LiteralPath $ServiceScript) {
  & $ServiceScript stop | Out-Null
}
if (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
}

# The long-lived agent key must not stay recoverable in the Recycle Bin.
if (Test-Path -LiteralPath $CredentialPath -PathType Leaf) {
  Remove-Item -LiteralPath $CredentialPath -Force
}

if (Test-Path -LiteralPath $InstallRoot) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
    $InstallRoot,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
}

Write-Output 'Deleted the local agent key, removed the logon task and moved the agent to the Recycle Bin. Logs were kept.'
