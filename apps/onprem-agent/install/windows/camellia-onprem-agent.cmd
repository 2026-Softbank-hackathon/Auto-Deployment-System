@echo off
rem Camellia on-prem agent launcher for Windows.
rem   (no argument)                     run the agent in this window
rem   register                          first registration with a one-time token
rem   start | stop | restart | status   manage the logon task that keeps the agent running
rem   uninstall                         remove the agent (logs are kept)
setlocal
set "AGENT_ROOT=%~dp0.."
set "ACTION=%~1"

if /i "%ACTION%"=="register" goto register
if /i "%ACTION%"=="start" goto service
if /i "%ACTION%"=="stop" goto service
if /i "%ACTION%"=="restart" goto service
if /i "%ACTION%"=="status" goto service
if /i "%ACTION%"=="uninstall" goto uninstall
if not "%ACTION%"=="" goto usage

node "%AGENT_ROOT%\lib\main.js"
exit /b

:register
node "%AGENT_ROOT%\lib\main.js" --register-only
exit /b

:service
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0camellia-onprem-agent-service.ps1" %ACTION%
exit /b

:uninstall
rem The uninstaller removes this file too. "(goto)" leaves the batch file first, so cmd
rem does not try to read it again after it is gone.
(goto) 2>nul & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0camellia-onprem-agent-uninstall.ps1"

:usage
echo Usage: camellia-onprem-agent [register^|start^|stop^|restart^|status^|uninstall] 1>&2
exit /b 1
