$ErrorActionPreference = 'Stop'
$watchdog = Join-Path $PSScriptRoot 'CodexBot-Watchdog.ps1'
if (-not (Test-Path -LiteralPath $watchdog)) { throw "Watchdog not found: $watchdog" }
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { throw "Windows PowerShell is missing: $windowsPowerShell" }
$action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Codex Bot Bridge' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Keeps the local Codex Bot worker and scheduled routines available while this Windows session is running.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Codex Bot Bridge'
