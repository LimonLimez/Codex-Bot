$ErrorActionPreference = 'SilentlyContinue'
Stop-ScheduledTask -TaskName 'Open Bot' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Open Bot' -Confirm:$false -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'Codex Bot Bridge' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Codex Bot Bridge' -Confirm:$false -ErrorAction SilentlyContinue
$installRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$portable = [IO.Path]::GetFullPath((Join-Path $installRoot 'app\Open Bot.exe'))
$proxy = [IO.Path]::GetFullPath((Join-Path $installRoot 'tools\cliproxyapi\cli-proxy-api.exe'))
$watchdogPath = Join-Path $PSScriptRoot 'CodexBot-Watchdog.ps1'
Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*$watchdogPath*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -in @($portable, $proxy))
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
