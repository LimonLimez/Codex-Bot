$ErrorActionPreference = 'Stop'
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\CodexBotBridgeWatchdogV1', [ref]$createdNew)
if (-not $createdNew) { $mutex.Dispose(); exit 0 }

$installRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$toolsRoot = Join-Path $installRoot 'tools'
$stateRoot = Join-Path $env:LOCALAPPDATA 'Codex Bot Bridge'
$runtimePath = Join-Path $stateRoot 'runtime.json'
$logRoot = Join-Path $stateRoot 'logs'
$serviceIdentityHelper = Join-Path $PSScriptRoot 'Local-Service-Identity.ps1'
if (-not (Test-Path -LiteralPath $serviceIdentityHelper)) { throw "Local service identity helper is missing: $serviceIdentityHelper" }
. $serviceIdentityHelper
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$watchdogLog = Join-Path $logRoot 'watchdog.log'

function Write-SafeWatchdogLog([string]$Message) {
    $timestamp = [DateTime]::UtcNow.ToString('o')
    Add-Content -LiteralPath $watchdogLog -Value "$timestamp $Message" -Encoding UTF8
}

function Get-RequiredRuntimeValue($Runtime, [string]$Name) {
    $property = $Runtime.PSObject.Properties[$Name]
    if ($null -eq $property) { throw "runtime.json is missing required field '$Name'." }
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
        throw "runtime.json field '$Name' must be a URL-safe secret of at least 24 characters."
    }
    return $token
}

function Read-ValidatedRuntime([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { throw 'runtime.json is missing.' }
    try {
        $candidate = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    } catch {
        throw 'runtime.json is not valid JSON.'
    }
    if ($null -eq $candidate -or $candidate -is [System.Array]) { throw 'runtime.json must contain one configuration object.' }

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

try {
    $runtime = Read-ValidatedRuntime $runtimePath
} catch {
    Write-SafeWatchdogLog $_.Exception.Message
    $mutex.ReleaseMutex()
    $mutex.Dispose()
    exit 1
}

$portable = Join-Path $installRoot 'app\Codex Bot.exe'
$hostMain = Join-Path $installRoot 'app\resources\app.asar\dist\host\host-main.cjs'
$proxyExe = Join-Path $toolsRoot 'cliproxyapi\cli-proxy-api.exe'
$proxyConfig = Join-Path $stateRoot 'cliproxy\config.yaml'
$proxyAuth = Join-Path $stateRoot 'cliproxy\auth'
$hostData = Join-Path $stateRoot 'host-data'
$browserData = Join-Path $stateRoot 'browser-seats'
New-Item -ItemType Directory -Force -Path $hostData, $browserData | Out-Null

foreach ($required in @($portable, $proxyExe, $proxyConfig)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Write-SafeWatchdogLog 'A required installed runtime file is missing; the watchdog stopped.'
        $mutex.ReleaseMutex()
        $mutex.Dispose()
        exit 1
    }
}

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

function Set-RequiredHostSettings {
    try {
        if (-not (Test-ExpectedLoopbackListener -Port ([int]$runtime.gatewayPort) -ExpectedExecutable $portable -ExpectedProcessId $script:expectedHostProcessId)) { return $false }
        $headers = @{ Authorization = "Bearer $($runtime.gatewayToken)" }
        $body = @{ localToolPermission = 'ask' } | ConvertTo-Json -Compress
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($runtime.gatewayPort)/api/setHostSettings" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 5
        return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300
    } catch {
        return $false
    }
}

function Set-WorkerEnvironment {
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
}

$exitCode = 0
try {
    $lastProxyStart = [DateTime]::MinValue
    $lastHostStart = [DateTime]::MinValue
    $lastSettingsWarning = [DateTime]::MinValue

    while ($true) {
        $proxyReady = Test-CLIProxyAPI
        if (-not $proxyReady) {
            if (Test-LocalPortListener ([int]$runtime.proxyPort)) {
                if (-not (Wait-ForAuthenticatedService ${function:Test-CLIProxyAPI} 10)) {
                    throw "Port $($runtime.proxyPort) is occupied by a service that is not this installation's authenticated CLIProxyAPI; the watchdog stopped."
                }
                $proxyReady = $true
            } elseif (([DateTime]::UtcNow - $lastProxyStart).TotalSeconds -ge 60) {
                $lastProxyStart = [DateTime]::UtcNow
                try {
                    $proxyProcess = Start-Process -FilePath $proxyExe -ArgumentList @('-config', "`"$proxyConfig`"") -WindowStyle Hidden -PassThru
                    $script:expectedProxyProcessId = [int]$proxyProcess.Id
                } catch {
                    Write-SafeWatchdogLog 'CLIProxyAPI could not be started; the watchdog will retry.'
                }
                $proxyReady = Wait-ForAuthenticatedService ${function:Test-CLIProxyAPI} 45
                if (-not $proxyReady -and (Test-LocalPortListener ([int]$runtime.proxyPort))) {
                    throw 'CLIProxyAPI opened its configured port but did not pass the authenticated readiness check; the watchdog stopped.'
                }
            }
        }

        $gatewayReady = Test-CoworkerGateway
        if (-not $gatewayReady) {
            if (Test-LocalPortListener ([int]$runtime.gatewayPort)) {
                if (-not (Wait-ForAuthenticatedService ${function:Test-CoworkerGateway} 10)) {
                    throw "Port $($runtime.gatewayPort) is occupied by a service that is not this installation's authenticated coworker gateway; the watchdog stopped."
                }
                $gatewayReady = $true
            } elseif (([DateTime]::UtcNow - $lastHostStart).TotalSeconds -ge 60) {
                Set-WorkerEnvironment
                $env:ELECTRON_RUN_AS_NODE = '1'
                $env:SAND_DATA_ROOT = $hostData
                $env:SAND_HOST_PORT = [string]$runtime.gatewayPort
                $env:SAND_GATEWAY_TOKEN = [string]$runtime.gatewayToken
                $lastHostStart = [DateTime]::UtcNow
                try {
                    $hostProcess = Start-Process -FilePath $portable -ArgumentList @("`"$hostMain`"") -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'host.stdout.log') -RedirectStandardError (Join-Path $logRoot 'host.stderr.log') -PassThru
                    $script:expectedHostProcessId = [int]$hostProcess.Id
                } catch {
                    Write-SafeWatchdogLog 'The local coworker host could not be started; the watchdog will retry.'
                } finally {
                    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
                    Remove-Item Env:SAND_DATA_ROOT -ErrorAction SilentlyContinue
                    Remove-Item Env:SAND_HOST_PORT -ErrorAction SilentlyContinue
                    Remove-Item Env:SAND_GATEWAY_TOKEN -ErrorAction SilentlyContinue
                }
                $gatewayReady = Wait-ForAuthenticatedService ${function:Test-CoworkerGateway} 120
                if (-not $gatewayReady -and (Test-LocalPortListener ([int]$runtime.gatewayPort))) {
                    throw 'The local coworker host opened its configured port but did not pass the authenticated readiness check; the watchdog stopped.'
                }
            }
        }

        if ($gatewayReady -and -not (Test-BrowserView)) {
            if (Test-LocalPortListener ([int]$runtime.viewPort)) {
                if (-not (Test-ExpectedLoopbackListener -Port ([int]$runtime.viewPort) -ExpectedExecutable $portable -ExpectedProcessId $script:expectedHostProcessId)) {
                    throw "Port $($runtime.viewPort) is occupied by a browser-view listener that does not belong to this installation; the watchdog stopped without sending a view credential."
                }
                if (-not (Wait-ForAuthenticatedService ${function:Test-BrowserView} 10)) {
                    throw 'The verified browser-view process did not pass its authenticated readiness check; the watchdog stopped.'
                }
            } elseif (-not (Wait-ForAuthenticatedService ${function:Test-BrowserView} 30)) {
                Write-SafeWatchdogLog 'The browser-view service stopped; restarting the verified coworker host.'
                if (-not (Stop-ExpectedLoopbackListener -Port ([int]$runtime.gatewayPort) -ExpectedExecutable $portable -ExpectedProcessId $script:expectedHostProcessId)) {
                    throw 'The browser-view service is unavailable and the coworker host identity could not be verified for a safe restart.'
                }
                $script:expectedHostProcessId = 0
                $lastHostStart = [DateTime]::MinValue
                $gatewayReady = $false
            }
        }

        if ($gatewayReady -and -not (Set-RequiredHostSettings)) {
            if (([DateTime]::UtcNow - $lastSettingsWarning).TotalSeconds -ge 60) {
                Write-SafeWatchdogLog 'The gateway is ready, but required local tool settings could not be refreshed; the watchdog will retry.'
                $lastSettingsWarning = [DateTime]::UtcNow
            }
        }
        Start-Sleep -Seconds 10
    }
} catch {
    Write-SafeWatchdogLog $_.Exception.Message
    $exitCode = 2
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
exit $exitCode
