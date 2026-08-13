param(
    [switch]$ForceReload,
    [switch]$DebugRenderer
)

$ErrorActionPreference = 'Stop'
$installRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$toolsRoot = Join-Path $installRoot 'tools'
$appRoot = Join-Path $installRoot 'app'
$stateRoot = Join-Path $env:LOCALAPPDATA 'Codex Bot Bridge'
$runtimePath = Join-Path $stateRoot 'runtime.json'
$serviceIdentityHelper = Join-Path $PSScriptRoot 'Local-Service-Identity.ps1'
if (-not (Test-Path -LiteralPath $serviceIdentityHelper)) { throw "Local service identity helper is missing: $serviceIdentityHelper" }
. $serviceIdentityHelper
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { throw "Windows PowerShell is missing: $windowsPowerShell" }

function Get-RequiredRuntimeValue($Runtime, [string]$Name) {
    $property = $Runtime.PSObject.Properties[$Name]
    if ($null -eq $property) { throw "runtime.json is missing required field '$Name'. Re-run the installer." }
    return $property.Value
}

function Get-ValidatedInteger($Value, [string]$Name, [int]$Minimum, [int]$Maximum) {
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [System.Array]) {
        throw "runtime.json field '$Name' must be an integer from $Minimum through $Maximum."
    }
    $parsed = 0
    if (-not [int]::TryParse([string]$Value, [ref]$parsed) -or $parsed -lt $Minimum -or $parsed -gt $Maximum) {
        throw "runtime.json field '$Name' must be an integer from $Minimum through $Maximum."
    }
    return $parsed
}

function Get-ValidatedToken($Value, [string]$Name) {
    $token = [string]$Value
    if ([string]::IsNullOrWhiteSpace($token) -or $token -cnotmatch '^[A-Za-z0-9_-]{24,}$') {
        throw "runtime.json field '$Name' must be a URL-safe secret of at least 24 characters. Re-run the installer."
    }
    return $token
}

function Read-ValidatedRuntime([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Codex Bot is not configured. Re-run the installer. Missing: $Path"
    }
    try {
        $candidate = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    } catch {
        throw 'runtime.json is not valid JSON. Re-run the installer.'
    }
    if ($null -eq $candidate -or $candidate -is [System.Array]) {
        throw 'runtime.json must contain one configuration object. Re-run the installer.'
    }

    $candidate.gatewayPort = Get-ValidatedInteger (Get-RequiredRuntimeValue $candidate 'gatewayPort') 'gatewayPort' 1 65535
    $candidate.viewPort = Get-ValidatedInteger (Get-RequiredRuntimeValue $candidate 'viewPort') 'viewPort' 1 65535
    $candidate.proxyPort = Get-ValidatedInteger (Get-RequiredRuntimeValue $candidate 'proxyPort') 'proxyPort' 1 65535
    $ports = @($candidate.gatewayPort, $candidate.viewPort, $candidate.proxyPort)
    if (($ports | Select-Object -Unique).Count -ne $ports.Count) {
        throw 'runtime.json gatewayPort, viewPort, and proxyPort must be distinct.'
    }

    $candidate.gatewayToken = Get-ValidatedToken (Get-RequiredRuntimeValue $candidate 'gatewayToken') 'gatewayToken'
    $candidate.viewToken = Get-ValidatedToken (Get-RequiredRuntimeValue $candidate 'viewToken') 'viewToken'
    $candidate.proxyKey = Get-ValidatedToken (Get-RequiredRuntimeValue $candidate 'proxyKey') 'proxyKey'
    $candidate.maxBrowserSeats = Get-ValidatedInteger (Get-RequiredRuntimeValue $candidate 'maxBrowserSeats') 'maxBrowserSeats' 1 3

    $model = [string](Get-RequiredRuntimeValue $candidate 'model')
    if ([string]::IsNullOrWhiteSpace($model)) { throw "runtime.json field 'model' cannot be empty." }
    $candidate.model = $model.Trim()

    $reasoningEffort = ([string](Get-RequiredRuntimeValue $candidate 'reasoningEffort')).Trim().ToLowerInvariant()
    $allowedReasoningEfforts = @('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')
    if ($allowedReasoningEfforts -notcontains $reasoningEffort) {
        throw "runtime.json field 'reasoningEffort' is not supported."
    }
    $candidate.reasoningEffort = $reasoningEffort
    return $candidate
}

$runtime = Read-ValidatedRuntime $runtimePath

$portable = Join-Path $appRoot 'Codex Bot.exe'
$proxyExe = Join-Path $toolsRoot 'cliproxyapi\cli-proxy-api.exe'
$proxyConfig = Join-Path $stateRoot 'cliproxy\config.yaml'
$proxyAuth = Join-Path $stateRoot 'cliproxy\auth'
$hostMain = Join-Path $appRoot 'resources\app.asar\dist\host\host-main.cjs'
$hostData = Join-Path $stateRoot 'host-data'
$logRoot = Join-Path $stateRoot 'logs'
$desktopData = Join-Path $stateRoot 'desktop-user-data'
$browserData = Join-Path $stateRoot 'browser-seats'

foreach ($required in @($portable, $proxyExe, $proxyConfig)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required Codex Bot file is missing: $required" }
}
foreach ($directory in @($stateRoot, $hostData, $logRoot, $desktopData, $browserData)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

$env:CODEX_BOT_STATE_ROOT = $stateRoot
$env:GROK_BOT_CLIPROXY_BRIDGE = Join-Path $toolsRoot 'src\bridge.cjs'
$env:GROK_BOT_CLIPROXY_URL = "http://127.0.0.1:$($runtime.proxyPort)/v1"
$env:GROK_BOT_CLIPROXY_KEY = [string]$runtime.proxyKey
$env:GROK_BOT_CLIPROXY_MODEL = [string]$runtime.model
$env:GROK_BOT_REASONING_EFFORT = [string]$runtime.reasoningEffort
$env:GROK_BOT_CLIPROXY_EXE = $proxyExe
$env:GROK_BOT_CLIPROXY_CONFIG = $proxyConfig
$env:GROK_BOT_CODEX_AUTH_DIR = $proxyAuth
$env:GROK_BOT_LOCAL_ROUTINES = '1'
$env:GROK_BOT_WINDOWS_COMPUTER_BRIDGE = Join-Path $toolsRoot 'src\browser-seat-bridge.cjs'
$env:GROK_BOT_USE_LOCAL_COMPUTER = '1'
$env:GROK_BOT_BROWSER_SEATS = '1'
$env:GROK_BOT_BROWSER_SEAT_LIMIT = [string]$runtime.maxBrowserSeats
$env:GROK_BOT_BROWSER_SEAT_DATA = $browserData
$env:GROK_BOT_BROWSER_VIEW_PORT = [string]$runtime.viewPort
$env:GROK_BOT_BROWSER_VIEW_TOKEN = [string]$runtime.viewToken
$env:SAND_AUTO_REVIEW_MODE = 'off'
$env:GROK_BOT_LOCAL_ONLY = '1'
$env:SAND_DISABLE_TELEMETRY = '1'
$env:SAND_DISABLE_ANALYTICS = '1'
$env:SAND_DISABLE_UPDATES = '1'
$env:SAND_BACKEND_URL = 'http://127.0.0.1:1'

$script:expectedProxyProcessId = 0
$script:expectedHostProcessId = 0

function Test-CLIProxyAPI {
    try {
        if (-not (Test-ExpectedLoopbackListener -Port ([int]$runtime.proxyPort) -ExpectedExecutable $proxyExe -ExpectedProcessId $script:expectedProxyProcessId)) { return $false }
        $headers = @{ Authorization = "Bearer $($runtime.proxyKey)" }
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($runtime.proxyPort)/v1/models" -Method Get -Headers $headers -UseBasicParsing -TimeoutSec 5
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { return $false }
        $payload = [string]$response.Content | ConvertFrom-Json
        return $null -ne $payload -and $null -ne $payload.PSObject.Properties['data']
    } catch {
        return $false
    }
}

function Test-CoworkerGateway {
    try {
        if (-not (Test-ExpectedLoopbackListener -Port ([int]$runtime.gatewayPort) -ExpectedExecutable $portable -ExpectedProcessId $script:expectedHostProcessId)) { return $false }
        $headers = @{ Authorization = "Bearer $($runtime.gatewayToken)" }
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($runtime.gatewayPort)/api/listAgents" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 5
        return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300
    } catch {
        return $false
    }
}

function Test-BrowserView {
    try {
        if (-not (Test-ExpectedLoopbackListener -Port ([int]$runtime.viewPort) -ExpectedExecutable $portable -ExpectedProcessId $script:expectedHostProcessId)) { return $false }
        $headers = @{ 'X-Codex-Seat-Token' = [string]$runtime.viewToken }
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($runtime.viewPort)/api/status" -Method Get -Headers $headers -UseBasicParsing -TimeoutSec 5
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { return $false }
        $payload = [string]$response.Content | ConvertFrom-Json
        return $null -ne $payload -and $null -ne $payload.PSObject.Properties['maxActive']
    } catch {
        return $false
    }
}

function Wait-ForAuthenticatedService([scriptblock]$Probe, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (& $Probe) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

if (-not (Test-CLIProxyAPI)) {
    if (Test-LocalPortListener ([int]$runtime.proxyPort)) {
        if (-not (Wait-ForAuthenticatedService ${function:Test-CLIProxyAPI} 5)) {
            throw "Port $($runtime.proxyPort) is occupied by a service that is not this installation's authenticated CLIProxyAPI. Close that service or change the runtime ports."
        }
    } else {
        $proxyProcess = Start-Process -FilePath $proxyExe -ArgumentList @('-config', "`"$proxyConfig`"") -WindowStyle Hidden -PassThru
        $script:expectedProxyProcessId = [int]$proxyProcess.Id
        if (-not (Wait-ForAuthenticatedService ${function:Test-CLIProxyAPI} 45)) {
            if (Test-LocalPortListener ([int]$runtime.proxyPort)) {
                throw 'CLIProxyAPI opened its configured port but did not pass the authenticated readiness check.'
            }
            throw 'CLIProxyAPI did not become ready.'
        }
    }
}

if ($ForceReload) {
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $portable } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do { Start-Sleep -Milliseconds 200 } until (-not (Test-LocalPortListener ([int]$runtime.gatewayPort)) -or [DateTime]::UtcNow -ge $deadline)
}

if (-not (Test-CoworkerGateway)) {
    if (Test-LocalPortListener ([int]$runtime.gatewayPort)) {
        if (-not (Wait-ForAuthenticatedService ${function:Test-CoworkerGateway} 5)) {
            throw "Port $($runtime.gatewayPort) is occupied by a service that is not this installation's authenticated coworker gateway. Close that service or change the runtime ports."
        }
    } else {
        $env:ELECTRON_RUN_AS_NODE = '1'
        $env:SAND_DATA_ROOT = $hostData
        $env:SAND_HOST_PORT = [string]$runtime.gatewayPort
        $env:SAND_GATEWAY_TOKEN = [string]$runtime.gatewayToken
        try {
            $hostProcess = Start-Process -FilePath $portable -ArgumentList @("`"$hostMain`"") -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'host.stdout.log') -RedirectStandardError (Join-Path $logRoot 'host.stderr.log') -PassThru
            $script:expectedHostProcessId = [int]$hostProcess.Id
        } finally {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
            Remove-Item Env:SAND_DATA_ROOT -ErrorAction SilentlyContinue
            Remove-Item Env:SAND_HOST_PORT -ErrorAction SilentlyContinue
            Remove-Item Env:SAND_GATEWAY_TOKEN -ErrorAction SilentlyContinue
        }
        if (-not (Wait-ForAuthenticatedService ${function:Test-CoworkerGateway} 120)) {
            if (Test-LocalPortListener ([int]$runtime.gatewayPort)) {
                throw 'The local coworker host opened its configured port but did not pass the authenticated readiness check.'
            }
            throw "The local coworker host did not start. Check $logRoot"
        }
    }
}

if (-not (Wait-ForAuthenticatedService ${function:Test-BrowserView} 30)) {
    if (Test-LocalPortListener ([int]$runtime.viewPort)) {
        throw "Port $($runtime.viewPort) is occupied by a browser-view listener that does not belong to this installation. No view credential was sent."
    }
    throw 'The authenticated local browser-view service did not become ready. The desktop was not started.'
}

$headers = @{ Authorization = "Bearer $($runtime.gatewayToken)" }
$body = @{ localToolPermission = 'ask' } | ConvertTo-Json -Compress
$hostSettingsApplied = $false
for ($attempt = 0; $attempt -lt 12 -and -not $hostSettingsApplied; $attempt++) {
    try {
        if (-not (Test-ExpectedLoopbackListener -Port ([int]$runtime.gatewayPort) -ExpectedExecutable $portable -ExpectedProcessId $script:expectedHostProcessId)) {
            throw 'The coworker gateway listener identity changed before host settings were applied.'
        }
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($runtime.gatewayPort)/api/setHostSettings" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 5
        $hostSettingsApplied = [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300
    } catch {
        $hostSettingsApplied = $false
    }
    if (-not $hostSettingsApplied) { Start-Sleep -Seconds 1 }
}
if (-not $hostSettingsApplied) {
    throw 'The coworker host is reachable, but required local tool settings could not be applied. The desktop was not started.'
}

$env:SAND_HOST_GATEWAY_URL = "http://127.0.0.1:$($runtime.gatewayPort)"
$env:SAND_HOST_GATEWAY_TOKEN = [string]$runtime.gatewayToken
$env:SAND_USER_DATA_DIR = $desktopData
Remove-Item Env:GROK_BOT_WINDOWS_COMPUTER_BRIDGE -ErrorAction SilentlyContinue
Remove-Item Env:GROK_BOT_USE_LOCAL_COMPUTER -ErrorAction SilentlyContinue
Remove-Item Env:GROK_BOT_BROWSER_SEATS -ErrorAction SilentlyContinue

if ($DebugRenderer) {
    Start-Process -FilePath $portable -ArgumentList @('--remote-debugging-port=18319') | Out-Null
} else {
    Start-Process -FilePath $portable | Out-Null
}

$watchdog = Join-Path $PSScriptRoot 'CodexBot-Watchdog.ps1'
if (Test-Path -LiteralPath $watchdog) {
    Start-Process -FilePath $windowsPowerShell -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$watchdog`"") -WindowStyle Hidden | Out-Null
}
