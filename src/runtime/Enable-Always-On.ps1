$ErrorActionPreference = 'Stop'
$watchdog = Join-Path $PSScriptRoot 'CodexBot-Watchdog.ps1'
if (-not (Test-Path -LiteralPath $watchdog)) { throw "Watchdog not found: $watchdog" }
$hiddenRunner = Join-Path $PSScriptRoot 'CodexBot-Hidden-Runner.vbs'
if (-not (Test-Path -LiteralPath $hiddenRunner -PathType Leaf)) { throw "Windowless runtime launcher not found: $hiddenRunner" }
$windowsScriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $windowsScriptHost -PathType Leaf)) { throw "Windows Script Host is missing: $windowsScriptHost" }
$action = New-ScheduledTaskAction -Execute $windowsScriptHost -Argument "//B //NoLogo `"$hiddenRunner`" watchdog"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Codex Bot Bridge' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Keeps the local Codex Bot worker and scheduled routines available while this Windows session is running.' -Force | Out-Null
