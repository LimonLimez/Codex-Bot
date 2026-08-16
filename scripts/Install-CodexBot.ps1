param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$appRoot = Join-Path $InstallRoot 'app'
$toolsRoot = Join-Path $InstallRoot 'tools'
$vendorExe = Join-Path $appRoot 'Grok Bot.exe'
$openBotExe = Join-Path $appRoot 'Open Bot.exe'
$sourceAsar = Join-Path $appRoot 'resources\app.asar'
$patchedAsar = Join-Path $appRoot 'resources\app.openbot.asar'
$patchedUnpacked = $patchedAsar + '.unpacked'
$targetUnpacked = $sourceAsar + '.unpacked'
$patcher = Join-Path $toolsRoot 'scripts\patch-app.cjs'
$brandScript = Join-Path $toolsRoot 'scripts\brand-executable.cjs'
$brandIcon = Join-Path $toolsRoot 'assets\codex-bot.ico'
$proxyExe = Join-Path $toolsRoot 'cliproxyapi\cli-proxy-api.exe'
$officialComputerClient = Join-Path $toolsRoot 'src\official-computer-client.cjs'
$officialComputerHelper = Join-Path $toolsRoot 'src\official-computer-helper.cjs'
$noVncPackage = Join-Path $toolsRoot 'node_modules\@novnc\novnc\package.json'
$webSocketPackage = Join-Path $toolsRoot 'node_modules\ws\package.json'
$runtimeVerifier = Join-Path $toolsRoot 'integrity\Verify-GrokBotRuntime.ps1'
$runtimeManifest = Join-Path $toolsRoot 'integrity\grok-bot-0.18.0-windows-x64.manifest.json'
$disableAlwaysOn = Join-Path $toolsRoot 'runtime\Disable-Always-On.ps1'
$enableAlwaysOn = Join-Path $toolsRoot 'runtime\Enable-Always-On.ps1'
$managedRuntimeDebugLog = Join-Path $appRoot 'debug.log'

foreach ($required in @($vendorExe, $sourceAsar, $patcher, $brandScript, $brandIcon, $proxyExe, $officialComputerClient, $officialComputerHelper, $noVncPackage, $webSocketPackage, $runtimeVerifier, $runtimeManifest, $disableAlwaysOn, $enableAlwaysOn)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Installer input is missing: $required" }
}

# Chromium can leave this managed diagnostic file beside the derived executable.
# It is not part of the vendor tree and must not make an otherwise exact upgrade
# fail before the copied runtime is verified. Any other unexpected path remains
# a hard failure in the complete-tree verifier below.
if (Test-Path -LiteralPath $managedRuntimeDebugLog) {
    Remove-Item -LiteralPath $managedRuntimeDebugLog -Force
}

# The copied runtime is untrusted until its complete tree and pinned signer have
# been checked. This must remain before the first Start-Process invocation.
& $runtimeVerifier -InstallRoot $appRoot -ManifestPath $runtimeManifest | Out-Null
& $disableAlwaysOn

$stateRoot = Join-Path $env:LOCALAPPDATA 'Open Bot'
$legacyStateRoot = Join-Path $env:LOCALAPPDATA 'Codex Bot Bridge'
if ((Test-Path -LiteralPath $legacyStateRoot) -and -not (Test-Path -LiteralPath $stateRoot)) {
    Move-Item -LiteralPath $legacyStateRoot -Destination $stateRoot
}
$runtimePath = Join-Path $stateRoot 'runtime.json'
$cliproxyRoot = Join-Path $stateRoot 'cliproxy'
$authRoot = Join-Path $cliproxyRoot 'auth'
$proxyConfig = Join-Path $cliproxyRoot 'config.yaml'
New-Item -ItemType Directory -Force -Path $stateRoot, $cliproxyRoot, $authRoot, (Join-Path $stateRoot 'logs') | Out-Null

# Older derived builds could cache vendor experiment payloads before local-only
# mode was enforced. They contain no user OAuth data and are never needed here.
foreach ($legacyExperimentCache in @(
    (Join-Path $stateRoot 'host-data\sand-statsig-bootstrap.json'),
    (Join-Path $stateRoot 'desktop-user-data\sand-statsig-bootstrap.json')
)) {
    if (Test-Path -LiteralPath $legacyExperimentCache) {
        Remove-Item -LiteralPath $legacyExperimentCache -Force
    }
}

function New-UrlSafeSecret([int]$Bytes = 32) {
    $buffer = New-Object byte[] $Bytes
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-AvailableLoopbackPort([int]$Port) {
    $listener = $null
    try {
        $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), $Port
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $listener) { $listener.Stop() }
    }
}

function New-CryptoRandomLoopbackPort([System.Collections.Generic.HashSet[int]]$Reserved) {
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        for ($attempt = 0; $attempt -lt 512; $attempt++) {
            $buffer = New-Object byte[] 4
            $generator.GetBytes($buffer)
            $candidate = 20000 + [int]([BitConverter]::ToUInt32($buffer, 0) % 40001)
            if ($Reserved.Contains($candidate) -or -not (Test-AvailableLoopbackPort $candidate)) { continue }
            $Reserved.Add($candidate) | Out-Null
            return $candidate
        }
    } finally {
        $generator.Dispose()
    }
    throw 'Could not allocate three private local service ports. Close other applications and try again.'
}

function Get-RuntimeValueOrDefault($Runtime, [string]$Name, $Default) {
    if ($null -eq $Runtime) { return $Default }
    $property = $Runtime.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value -or [string]::IsNullOrWhiteSpace([string]$property.Value)) { return $Default }
    return $property.Value
}

$existingRuntime = $null
if (Test-Path -LiteralPath $runtimePath) {
    $existingRuntime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
}
$existingSchemaVersion = 0
if ($null -ne $existingRuntime) { [int]::TryParse([string](Get-RuntimeValueOrDefault $existingRuntime 'schemaVersion' 0), [ref]$existingSchemaVersion) | Out-Null }
$legacyFixedPorts = @(8317, 18317, 18318)
$existingPorts = @(
    [int](Get-RuntimeValueOrDefault $existingRuntime 'gatewayPort' 0),
    [int](Get-RuntimeValueOrDefault $existingRuntime 'viewPort' 0),
    [int](Get-RuntimeValueOrDefault $existingRuntime 'proxyPort' 0)
)
$requiresSecurityMigration = $null -eq $existingRuntime -or $existingSchemaVersion -lt 2 -or @($existingPorts | Where-Object { $legacyFixedPorts -contains $_ }).Count -ne 0

if ($requiresSecurityMigration) {
    $reservedPorts = New-Object 'System.Collections.Generic.HashSet[int]'
    $runtime = [ordered]@{
        schemaVersion = 2
        gatewayPort = New-CryptoRandomLoopbackPort $reservedPorts
        viewPort = New-CryptoRandomLoopbackPort $reservedPorts
        proxyPort = New-CryptoRandomLoopbackPort $reservedPorts
        gatewayToken = New-UrlSafeSecret
        viewToken = New-UrlSafeSecret
        proxyKey = New-UrlSafeSecret
        model = [string](Get-RuntimeValueOrDefault $existingRuntime 'model' 'gpt-5.6-terra')
        reasoningEffort = [string](Get-RuntimeValueOrDefault $existingRuntime 'reasoningEffort' 'high')
        maxBrowserSeats = [int](Get-RuntimeValueOrDefault $existingRuntime 'maxBrowserSeats' 3)
    }
    if ([string]$runtime.model -eq 'gpt-5.6-sol') { $runtime.model = 'gpt-5.6-terra' }
    $runtime | ConvertTo-Json | Set-Content -LiteralPath $runtimePath -Encoding UTF8
} else {
    $runtime = $existingRuntime
    if ([string]$runtime.model -eq 'gpt-5.6-sol') {
        $runtime.model = 'gpt-5.6-terra'
        $runtime | ConvertTo-Json | Set-Content -LiteralPath $runtimePath -Encoding UTF8
    }
}

$authYamlPath = $authRoot.Replace('\', '/')
$configYaml = @"
host: "127.0.0.1"
port: $($runtime.proxyPort)
auth-dir: "$authYamlPath"
api-keys:
  - "$($runtime.proxyKey)"
debug: false
logging-to-file: false
usage-statistics-enabled: false
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
plugins:
  enabled: false
oauth-model-alias:
  codex:
    - name: "gpt-5.6-sol"
      alias: "gpt-5.6-sol-fast"
      fork: true
      force-mapping: true
    - name: "gpt-5.6-terra"
      alias: "gpt-5.6-terra-fast"
      fork: true
      force-mapping: true
    - name: "gpt-5.6-luna"
      alias: "gpt-5.6-luna-fast"
      fork: true
      force-mapping: true
payload:
  override:
    - models:
        - name: "gpt-5.6-sol-fast"
          protocol: "codex"
        - name: "gpt-5.6-terra-fast"
          protocol: "codex"
        - name: "gpt-5.6-luna-fast"
          protocol: "codex"
      params:
        service_tier: priority
"@
$configYaml | Set-Content -LiteralPath $proxyConfig -Encoding UTF8

$env:ELECTRON_RUN_AS_NODE = '1'
try {
    $patchLog = Join-Path $stateRoot 'logs\install-patcher.log'
    $patchErrorLog = Join-Path $stateRoot 'logs\install-patcher.error.log'
    $patchArguments = @(
        "`"$patcher`"",
        '--source-asar', "`"$sourceAsar`"",
        '--target-asar', "`"$patchedAsar`"",
        '--runtime-config', "`"$runtimePath`""
    )
    $patchProcess = Start-Process -FilePath $vendorExe -ArgumentList $patchArguments -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $patchLog -RedirectStandardError $patchErrorLog
    if ($patchProcess.ExitCode -ne 0) {
        $detail = if (Test-Path -LiteralPath $patchErrorLog) { (Get-Content -Raw -LiteralPath $patchErrorLog).Trim() } else { '' }
        throw "Open Bot patcher failed with exit code $($patchProcess.ExitCode). $detail"
    }
    Copy-Item -LiteralPath $vendorExe -Destination $openBotExe -Force
    $brandProcess = Start-Process -FilePath $vendorExe -ArgumentList @("`"$brandScript`"", "`"$openBotExe`"", "`"$brandIcon`"") -Wait -PassThru -WindowStyle Hidden
    if ($brandProcess.ExitCode -ne 0) { throw "Executable branding failed with exit code $($brandProcess.ExitCode)" }
} finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $patchedAsar)) { throw 'The patcher did not create app.openbot.asar.' }
Move-Item -LiteralPath $patchedAsar -Destination $sourceAsar -Force
if (Test-Path -LiteralPath $patchedUnpacked) {
    if (Test-Path -LiteralPath $targetUnpacked) {
        $resolvedTarget = [IO.Path]::GetFullPath($targetUnpacked)
        if (-not $resolvedTarget.StartsWith($appRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to replace an unpacked directory outside the derived app copy.' }
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
    Move-Item -LiteralPath $patchedUnpacked -Destination $targetUnpacked
}

# Register the logon watchdog without starting it. The post-install launcher
# starts the desktop first, then hands supervision to this task, avoiding two
# first-run processes racing to claim the same private listeners.
& $enableAlwaysOn
Write-Output "Open Bot installed successfully. Runtime state: $stateRoot"
