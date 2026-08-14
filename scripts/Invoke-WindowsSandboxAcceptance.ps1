param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Interactive', 'Silent')]
    [string]$Scenario,
    [Parameter(Mandatory = $true)]
    [string]$ArtifactDirectory,
    [Parameter(Mandatory = $true)]
    [string]$HarnessDirectory,
    [Parameter(Mandatory = $true)]
    [string]$EvidenceDirectory,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedSha256,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedInstallerName,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{7,12}$')]
    [string]$ExpectedRevision,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedBrandedExecutableSha256,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedPatchInputsSha256,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedVendorManifestSha256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$sensitivePattern = '(?i)(authorization\s*:|bearer\s+[A-Za-z0-9._~+/=-]+|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|x-codex-seat-token|view[_ -]?token|gateway[_ -]?token|proxy[_ -]?key|api[_ -]?key|client[_ -]?secret|code[_ -]?verifier|[?&](?:code|state)=|password\s*[=:])'
$scriptExitCode = 1
$rawInstallerLog = Join-Path ([IO.Path]::GetTempPath()) ("CodexBot-Acceptance-{0}-{1}.log" -f $Scenario, [guid]::NewGuid().ToString('N'))
$workingEvidenceDirectory = Join-Path ([IO.Path]::GetTempPath()) ("CodexBot-Acceptance-Evidence-{0}" -f [guid]::NewGuid().ToString('N'))
$summary = [ordered]@{
    schemaVersion = 1
    scenario = $Scenario.ToLowerInvariant()
    status = 'running'
    artifactAudit = 'not-run'
    cleanBaseline = $false
    installerExitCode = $null
    postInstallVerified = $false
    authenticationAutomation = $false
    operatorAuthenticationReview = 'not-applicable'
    backendHealthVerified = $false
    directNavigationReview = $false
    takeoverReview = $false
    sensitiveDataCollected = $false
    error = $null
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $encoding = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($LiteralPath, $Value, $encoding)
}

function Get-NormalizedDirectory {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    return [IO.Path]::GetFullPath($LiteralPath).TrimEnd('\')
}

function Assert-ExactMappedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ((Get-NormalizedDirectory $Actual) -ine (Get-NormalizedDirectory $Expected)) {
        throw "$Label must be the fixed Windows Sandbox mapping '$Expected'."
    }
    $item = Get-Item -LiteralPath $Actual -Force
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label is not a real mapped directory."
    }
}

function Protect-EvidenceText {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { return '' }
    if ($Value -match $sensitivePattern) { return '[REDACTED SENSITIVE VALUE]' }
    $safe = $Value
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $safe = $safe.Replace($env:USERPROFILE, '%USERPROFILE%')
    }
    if (-not [string]::IsNullOrWhiteSpace($env:TEMP)) {
        $safe = $safe.Replace($env:TEMP, '%TEMP%')
    }
    if ($safe.Length -gt 2000) {
        $safe = $safe.Substring(0, 2000) + ' [TRUNCATED]'
    }
    return $safe
}

function Write-JsonEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][object]$Value
    )
    if ($Name -notmatch '^[a-z0-9-]+\.json$') {
        throw 'Evidence JSON names must use the fixed lowercase allowlist format.'
    }
    $path = Join-Path $workingEvidenceDirectory $Name
    Write-Utf8NoBom -LiteralPath $path -Value (($Value | ConvertTo-Json -Depth 8) + "`n")
}

function Get-ArtifactAudit {
    $artifactItems = @(Get-ChildItem -LiteralPath $ArtifactDirectory -Force)
    if ($artifactItems.Count -ne 2 -or @($artifactItems | Where-Object { $_.PSIsContainer }).Count -ne 0) {
        throw 'The read-only artifact mapping must contain exactly one installer and its sidecar.'
    }
    foreach ($item in $artifactItems) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The artifact mapping contains a reparse point.'
        }
    }

    if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw 'The expected installer version is invalid.'
    }
    $escapedVersion = [Regex]::Escape($ExpectedVersion)
    $expectedNamePattern = '^CodexBot-Setup-' + $escapedVersion + '-DEVELOPMENT-\d{8}T\d{9}Z-' + [Regex]::Escape($ExpectedRevision) + '\.exe$'
    if ($ExpectedInstallerName -cnotmatch $expectedNamePattern) {
        throw 'The pinned installer name is not the current DEVELOPMENT build naming form.'
    }

    $installerPath = Join-Path $ArtifactDirectory $ExpectedInstallerName
    $sidecarPath = "$installerPath.sha256"
    if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf) -or -not (Test-Path -LiteralPath $sidecarPath -PathType Leaf)) {
        throw 'The exact pinned installer pair is incomplete.'
    }
    $installer = Get-Item -LiteralPath $installerPath
    $sidecar = Get-Item -LiteralPath $sidecarPath
    if ($installer.Length -le 0 -or $sidecar.Length -le 0 -or $sidecar.Length -gt 1024) {
        throw 'The pinned installer pair has an invalid size.'
    }

    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash.ToLowerInvariant()
    if ($actualHash -cne $ExpectedSha256.ToLowerInvariant()) {
        throw 'The installer does not match the independently pinned SHA-256.'
    }
    $sidecarBytes = [IO.File]::ReadAllBytes($sidecarPath)
    foreach ($byte in $sidecarBytes) {
        if (($byte -gt 127) -or ($byte -eq 0)) { throw 'The sidecar is not plain ASCII.' }
    }
    $sidecarText = [Text.Encoding]::ASCII.GetString($sidecarBytes)
    if ($sidecarText.EndsWith("`r`n")) {
        $sidecarText = $sidecarText.Substring(0, $sidecarText.Length - 2)
    } elseif ($sidecarText.EndsWith("`n")) {
        $sidecarText = $sidecarText.Substring(0, $sidecarText.Length - 1)
    }
    if ($sidecarText.Contains("`r") -or $sidecarText.Contains("`n") -or $sidecarText -cne "$actualHash  $ExpectedInstallerName") {
        throw 'The checksum sidecar is not the exact canonical record.'
    }

    $metadata = $installer.VersionInfo
    if (([string]$metadata.ProductName).TrimEnd() -cne 'Codex Bot DEVELOPMENT TEST BUILD' -or
        ([string]$metadata.FileDescription).TrimEnd() -cne 'Codex Bot DEVELOPMENT TEST installer - DO NOT PUBLISH' -or
        ([string]$metadata.ProductVersion).TrimEnd() -cne "$ExpectedVersion DEVELOPMENT TEST BUILD") {
        throw 'The installer does not carry the required DEVELOPMENT/DO NOT PUBLISH PE metadata.'
    }

    $receiptPath = Join-Path $HarnessDirectory 'artifact-audit.json'
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        throw 'The read-only artifact audit receipt is missing.'
    }
    $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
    if ([string]$receipt.auditPolicy -cne 'codex-bot-development-sandbox-v1' -or
        -not [bool]$receipt.audited -or
        [string]$receipt.name -cne $ExpectedInstallerName -or
        [string]$receipt.sha256 -cne $actualHash -or
        [int64]$receipt.length -ne [int64]$installer.Length -or
        [string]$receipt.gitRevision -cne $ExpectedRevision.ToLowerInvariant() -or
        [string]$receipt.brandedExecutableSha256 -cne $ExpectedBrandedExecutableSha256.ToLowerInvariant() -or
        [string]$receipt.patchInputsSha256 -cne $ExpectedPatchInputsSha256.ToLowerInvariant() -or
        [string]$receipt.vendorManifestSha256 -cne $ExpectedVendorManifestSha256.ToLowerInvariant()) {
        throw 'The artifact does not match its generated audit receipt.'
    }

    return [pscustomobject][ordered]@{
        policy = 'codex-bot-development-sandbox-v1'
        name = $ExpectedInstallerName
        length = [int64]$installer.Length
        sha256 = $actualHash
        version = $ExpectedVersion
        brandedExecutableSha256 = $ExpectedBrandedExecutableSha256.ToLowerInvariant()
        patchInputsSha256 = $ExpectedPatchInputsSha256.ToLowerInvariant()
        vendorManifestSha256 = $ExpectedVendorManifestSha256.ToLowerInvariant()
        developmentOnly = $true
        doNotPublish = $true
    }
}

function Get-CleanBaselineReport {
    $indicators = New-Object Collections.Generic.List[string]
    $pathChecks = [ordered]@{
        'local-program-codex-bot' = (Join-Path $env:LOCALAPPDATA 'Programs\Codex Bot')
        'local-program-grok-bot' = (Join-Path $env:LOCALAPPDATA 'Programs\Grok Bot')
        'local-program-grok-bot-hyphenated' = (Join-Path $env:LOCALAPPDATA 'Programs\grok-bot')
        'local-program-cursor' = (Join-Path $env:LOCALAPPDATA 'Programs\Cursor')
        'local-state-codex-bridge' = (Join-Path $env:LOCALAPPDATA 'Codex Bot Bridge')
        'local-state-codex-bot' = (Join-Path $env:LOCALAPPDATA 'Codex Bot')
        'local-state-grok-bot' = (Join-Path $env:LOCALAPPDATA 'Grok Bot')
        'local-state-cursor' = (Join-Path $env:LOCALAPPDATA 'Cursor')
        'roaming-state-codex-bot' = (Join-Path $env:APPDATA 'Codex Bot')
        'roaming-state-grok-bot' = (Join-Path $env:APPDATA 'Grok Bot')
        'roaming-state-cursor' = (Join-Path $env:APPDATA 'Cursor')
        'profile-state-codex' = (Join-Path $env:USERPROFILE '.codex')
        'profile-state-cursor' = (Join-Path $env:USERPROFILE '.cursor')
        'machine-program-codex-bot' = (Join-Path $env:ProgramFiles 'Codex Bot')
        'machine-program-grok-bot' = (Join-Path $env:ProgramFiles 'Grok Bot')
        'machine-program-cursor' = (Join-Path $env:ProgramFiles 'Cursor')
    }
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $pathChecks['machine-x86-codex-bot'] = Join-Path ${env:ProgramFiles(x86)} 'Codex Bot'
        $pathChecks['machine-x86-grok-bot'] = Join-Path ${env:ProgramFiles(x86)} 'Grok Bot'
        $pathChecks['machine-x86-cursor'] = Join-Path ${env:ProgramFiles(x86)} 'Cursor'
    }
    foreach ($entry in $pathChecks.GetEnumerator()) {
        if (Test-Path -LiteralPath $entry.Value) { $indicators.Add("path:$($entry.Key)") }
    }

    $uninstallRoots = @(
        'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $uninstallRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction Stop) {
            $displayName = [string](Get-ItemPropertyValue -LiteralPath $key.PSPath -Name DisplayName -ErrorAction SilentlyContinue)
            if ($displayName -match '(?i)^(?:Codex Bot|Grok Bot|Cursor)(?:\s|$)') {
                $kind = if ($root -match 'HKEY_CURRENT_USER') { 'hkcu' } elseif ($root -match 'WOW6432Node') { 'hklm32' } else { 'hklm64' }
                $product = if ($displayName -match '(?i)^Codex Bot') { 'codex-bot' } elseif ($displayName -match '(?i)^Grok Bot') { 'grok-bot' } else { 'cursor' }
                $indicators.Add("registry:$kind-$product")
            }
        }
    }
    $appPathChecks = @(
        'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Codex Bot.exe',
        'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Grok Bot.exe',
        'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Cursor.exe',
        'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\Codex Bot.exe',
        'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\Grok Bot.exe',
        'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\Cursor.exe'
    )
    for ($index = 0; $index -lt $appPathChecks.Count; $index++) {
        if (Test-Path -LiteralPath $appPathChecks[$index]) { $indicators.Add("app-path:$index") }
    }

    $processNames = @('Codex Bot', 'Grok Bot', 'Cursor', 'codex-bot', 'grok-bot')
    foreach ($process in Get-Process -ErrorAction Stop) {
        if ($processNames -icontains $process.ProcessName) {
            $indicators.Add('process:' + $process.ProcessName.ToLowerInvariant().Replace(' ', '-'))
        }
    }
    if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
        throw 'Get-ScheduledTask is unavailable, so the clean baseline cannot be proven.'
    }
    foreach ($task in Get-ScheduledTask -ErrorAction Stop) {
        $taskIdentity = ([string]$task.TaskPath + [string]$task.TaskName)
        if ($taskIdentity -match '(?i)(Codex Bot|Grok Bot|Cursor)') {
            $product = if ($taskIdentity -match '(?i)Codex Bot') { 'codex-bot' } elseif ($taskIdentity -match '(?i)Grok Bot') { 'grok-bot' } else { 'cursor' }
            $indicators.Add("scheduled-task:$product")
        }
    }

    $unique = @($indicators | Sort-Object -Unique)
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        clean = $unique.Count -eq 0
        checked = @('filesystem-install-and-state', 'uninstall-registry', 'app-path-registry', 'processes', 'scheduled-tasks')
        findings = $unique
    }
}

function Copy-SanitizedInstallerLog {
    if (-not (Test-Path -LiteralPath $rawInstallerLog -PathType Leaf)) { return }
    $destination = Join-Path $workingEvidenceDirectory 'installer-sanitized.log'
    $encoding = New-Object Text.UTF8Encoding($false)
    $writer = New-Object IO.StreamWriter($destination, $false, $encoding)
    try {
        $lineCount = 0
        foreach ($line in Get-Content -LiteralPath $rawInstallerLog -ErrorAction Stop) {
            $lineCount++
            if ($lineCount -gt 25000) {
                $writer.WriteLine('[TRUNCATED AFTER 25000 LINES]')
                break
            }
            if ([string]$line -match $sensitivePattern) {
                $writer.WriteLine('[REDACTED SENSITIVE LINE]')
            } else {
                $writer.WriteLine((Protect-EvidenceText ([string]$line)))
            }
        }
    } finally {
        $writer.Dispose()
    }
}

function Get-RequiredRuntimeValue {
    param(
        [Parameter(Mandatory = $true)][object]$Runtime,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $property = $Runtime.PSObject.Properties[$Name]
    if ($null -eq $property) { throw 'The guest runtime configuration is incomplete.' }
    return $property.Value
}

function Get-ValidatedRuntimeInteger {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][int]$Minimum,
        [Parameter(Mandatory = $true)][int]$Maximum
    )
    if ($Value -is [bool] -or $Value -is [Array]) {
        throw 'The guest runtime configuration contains an invalid integer.'
    }
    $parsed = 0
    if (-not [int]::TryParse([string]$Value, [ref]$parsed) -or $parsed -lt $Minimum -or $parsed -gt $Maximum) {
        throw 'The guest runtime configuration contains an out-of-range integer.'
    }
    return $parsed
}

function Get-ValidatedRuntimeSecret {
    param([Parameter(Mandatory = $true)]$Value)
    $secret = [string]$Value
    if ($secret -cnotmatch '^[A-Za-z0-9_-]{24,512}$') {
        throw 'The guest runtime configuration contains an invalid protected value.'
    }
    return $secret
}

function Read-GuestRuntimeInMemory {
    $runtimePath = Join-Path $env:LOCALAPPDATA 'Codex Bot Bridge\runtime.json'
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
        throw 'The guest runtime configuration is missing.'
    }
    try {
        $candidate = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
    } catch {
        throw 'The guest runtime configuration is not valid JSON.'
    }
    if ($null -eq $candidate -or $candidate -is [Array] -or [int]$candidate.schemaVersion -ne 2) {
        throw 'The guest runtime configuration identity is invalid.'
    }
    $candidate.gatewayPort = Get-ValidatedRuntimeInteger (Get-RequiredRuntimeValue $candidate 'gatewayPort') 1 65535
    $candidate.viewPort = Get-ValidatedRuntimeInteger (Get-RequiredRuntimeValue $candidate 'viewPort') 1 65535
    $candidate.proxyPort = Get-ValidatedRuntimeInteger (Get-RequiredRuntimeValue $candidate 'proxyPort') 1 65535
    $ports = @([int]$candidate.gatewayPort, [int]$candidate.viewPort, [int]$candidate.proxyPort)
    if (@($ports | Sort-Object -Unique).Count -ne 3) {
        throw 'The guest runtime service ports are not distinct.'
    }
    $candidate.gatewayToken = Get-ValidatedRuntimeSecret (Get-RequiredRuntimeValue $candidate 'gatewayToken')
    $candidate.viewToken = Get-ValidatedRuntimeSecret (Get-RequiredRuntimeValue $candidate 'viewToken')
    $candidate.proxyKey = Get-ValidatedRuntimeSecret (Get-RequiredRuntimeValue $candidate 'proxyKey')
    return $candidate
}

function Get-VerifiedGuestListenerReport {
    param(
        [Parameter(Mandatory = $true)][object]$Runtime,
        [Parameter(Mandatory = $true)][string]$CodexRoot
    )

    $codexExecutable = [IO.Path]::GetFullPath((Join-Path $CodexRoot 'app\Codex Bot.exe'))
    $vendorExecutable = [IO.Path]::GetFullPath((Join-Path $CodexRoot 'app\Grok Bot.exe'))
    $proxyExecutable = [IO.Path]::GetFullPath((Join-Path $CodexRoot 'tools\cliproxyapi\cli-proxy-api.exe'))
    $identityHelper = Join-Path $CodexRoot 'tools\runtime\Local-Service-Identity.ps1'
    foreach ($required in @($codexExecutable, $vendorExecutable, $proxyExecutable, $identityHelper)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw 'A required installed listener-identity file is missing.'
        }
    }
    . $identityHelper

    if (-not (Test-ExpectedLoopbackListener -Port ([int]$Runtime.gatewayPort) -ExpectedExecutable $codexExecutable) -or
        -not (Test-ExpectedLoopbackListener -Port ([int]$Runtime.viewPort) -ExpectedExecutable $codexExecutable) -or
        -not (Test-ExpectedLoopbackListener -Port ([int]$Runtime.proxyPort) -ExpectedExecutable $proxyExecutable)) {
        throw 'An expected authenticated product listener failed its path, owner, PID, or loopback identity check.'
    }

    $knownPaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in @($codexExecutable, $vendorExecutable, $proxyExecutable)) {
        $knownPaths.Add($path) | Out-Null
    }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $productProcessIds = New-Object 'Collections.Generic.HashSet[int]'
    foreach ($process in Get-CimInstance Win32_Process -ErrorAction Stop) {
        if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) { continue }
        try {
            $processPath = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
        } catch {
            continue
        }
        if (-not $knownPaths.Contains($processPath)) { continue }
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
        if ([int]$owner.ReturnValue -ne 0 -or [string]$owner.Sid -ne $currentSid) {
            throw 'A product process is not owned by the current Sandbox user.'
        }
        $productProcessIds.Add([int]$process.ProcessId) | Out-Null
    }
    if ($productProcessIds.Count -lt 2 -or $productProcessIds.Count -gt 32) {
        throw 'The product process count is outside the acceptance bound.'
    }

    $tcpListeners = @(
        Get-NetTCPConnection -State Listen -ErrorAction Stop |
            Where-Object { $productProcessIds.Contains([int]$_.OwningProcess) }
    )
    if ($tcpListeners.Count -lt 3 -or $tcpListeners.Count -gt 32) {
        throw 'The product TCP-listener count is outside the acceptance bound.'
    }
    foreach ($listener in $tcpListeners) {
        if (@('127.0.0.1', '::1') -notcontains [string]$listener.LocalAddress) {
            throw 'A product TCP listener is exposed beyond loopback.'
        }
    }
    $listenerPorts = @($tcpListeners | Select-Object -ExpandProperty LocalPort -Unique)
    foreach ($expectedPort in @([int]$Runtime.gatewayPort, [int]$Runtime.viewPort, [int]$Runtime.proxyPort)) {
        if ($listenerPorts -notcontains $expectedPort) {
            throw 'An expected product TCP listener is absent.'
        }
    }

    $udpEndpoints = @(
        Get-NetUDPEndpoint -ErrorAction Stop |
            Where-Object { $productProcessIds.Contains([int]$_.OwningProcess) }
    )
    if ($udpEndpoints.Count -gt 16) {
        throw 'The product UDP-endpoint count is outside the acceptance bound.'
    }
    foreach ($endpoint in $udpEndpoints) {
        if (@('127.0.0.1', '::1') -notcontains [string]$endpoint.LocalAddress) {
            throw 'A product UDP endpoint is exposed beyond loopback.'
        }
    }

    return [pscustomobject][ordered]@{
        expectedListenersVerified = $true
        productListenersLoopbackOnly = $true
        productProcessCount = [int]$productProcessIds.Count
        productTcpListenerCount = [int]$tcpListeners.Count
        productUdpEndpointCount = [int]$udpEndpoints.Count
    }
}

function Invoke-GuestLoopbackJson {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$Headers,
        [ValidateSet('GET', 'POST')][string]$Method = 'GET',
        [string]$Body = '',
        [int]$MaximumCharacters = 2097152,
        [int]$TimeoutSeconds = 10
    )
    try {
        $arguments = @{
            Uri = "http://127.0.0.1:$Port$Path"
            Method = $Method
            Headers = $Headers
            UseBasicParsing = $true
            TimeoutSec = $TimeoutSeconds
        }
        if ($Method -eq 'POST') {
            $arguments.ContentType = 'application/json'
            $arguments.Body = $Body
        }
        $response = Invoke-WebRequest @arguments
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
            throw 'status'
        }
        $content = [string]$response.Content
        if ($content.Length -le 1 -or $content.Length -gt $MaximumCharacters) {
            throw 'size'
        }
        $payload = $content | ConvertFrom-Json
        $content = $null
        $response = $null
        if ($null -eq $payload -or $payload -is [Array]) { throw 'shape' }
        return $payload
    } catch {
        throw 'An authenticated guest loopback JSON probe failed.'
    }
}

function Invoke-GuestLoopbackStatusOnly {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$Headers,
        [Parameter(Mandatory = $true)][string]$Body
    )
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$Path" -Method Post -Headers $Headers -ContentType 'application/json' -Body $Body -UseBasicParsing -TimeoutSec 10
        $ok = [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300
        $response = $null
        if (-not $ok) { throw 'status' }
        return $true
    } catch {
        throw 'An authenticated guest loopback status probe failed.'
    }
}

function Get-BigEndianUInt32 {
    param(
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][int]$Offset
    )
    return [uint32](([uint64]$Bytes[$Offset] * 16777216) +
        ([uint64]$Bytes[$Offset + 1] * 65536) +
        ([uint64]$Bytes[$Offset + 2] * 256) +
        [uint64]$Bytes[$Offset + 3])
}

function Test-BoundedPngFrame {
    param([Parameter(Mandatory = $true)][object]$Frame)

    $bytes = $null
    $stream = $null
    $image = $null
    try {
        $encoded = [string]$Frame.screenshotBase64
        if ($encoded.Length -lt 60 -or $encoded.Length -gt (32 * 1024 * 1024) -or $encoded -cnotmatch '^[A-Za-z0-9+/]+={0,2}$') {
            throw 'encoded frame'
        }
        $bytes = [Convert]::FromBase64String($encoded)
        if ($bytes.Length -lt 45 -or $bytes.Length -gt (24 * 1024 * 1024)) {
            throw 'frame bytes'
        }
        $signature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
        for ($index = 0; $index -lt $signature.Length; $index++) {
            if ($bytes[$index] -ne $signature[$index]) { throw 'signature' }
        }
        if ((Get-BigEndianUInt32 $bytes 8) -ne 13 -or
            [Text.Encoding]::ASCII.GetString($bytes, 12, 4) -cne 'IHDR') {
            throw 'header'
        }
        $width = [int](Get-BigEndianUInt32 $bytes 16)
        $height = [int](Get-BigEndianUInt32 $bytes 20)
        if ($width -lt 1 -or $width -gt 4096 -or
            $height -lt 1 -or $height -gt 4096 -or
            ([int64]$width * [int64]$height) -gt 16777216) {
            throw 'dimensions'
        }
        $ending = [byte[]](0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130)
        for ($index = 0; $index -lt $ending.Length; $index++) {
            if ($bytes[$bytes.Length - $ending.Length + $index] -ne $ending[$index]) { throw 'ending' }
        }
        if ([string]$Frame.mimeType -cne 'image/png' -or
            [string]$Frame.provider -cne 'official' -or
            [int]$Frame.width -ne $width -or
            [int]$Frame.height -ne $height) {
            throw 'metadata'
        }

        Add-Type -AssemblyName System.Drawing
        $stream = New-Object IO.MemoryStream(, $bytes)
        $image = [Drawing.Image]::FromStream($stream, $true, $true)
        if ([int]$image.Width -ne $width -or [int]$image.Height -ne $height) {
            throw 'decoded dimensions'
        }
        return [pscustomobject][ordered]@{
            valid = $true
            width = $width
            height = $height
            byteCount = [int]$bytes.Length
        }
    } catch {
        throw 'The official computer did not return a valid bounded PNG frame.'
    } finally {
        if ($null -ne $image) { $image.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $Frame -and $null -ne $Frame.PSObject.Properties['screenshotBase64']) {
            $Frame.screenshotBase64 = $null
        }
        $bytes = $null
    }
}

function Get-GuestBackendVerification {
    $runtime = $null
    $viewHeaders = $null
    $proxyHeaders = $null
    $gatewayHeaders = $null
    $status = $null
    $models = $null
    $frame = $null
    try {
        $codexRoot = Join-Path $env:LOCALAPPDATA 'Programs\Codex Bot'
        $runtime = Read-GuestRuntimeInMemory
        $listeners = Get-VerifiedGuestListenerReport -Runtime $runtime -CodexRoot $codexRoot

        # These values exist only in guest process memory. They are never
        # returned, logged, placed in an exception, or written to evidence.
        $viewHeaders = @{ 'X-Codex-Seat-Token' = [string]$runtime.viewToken }
        $proxyHeaders = @{ Authorization = "Bearer $([string]$runtime.proxyKey)" }
        $gatewayHeaders = @{ Authorization = "Bearer $([string]$runtime.gatewayToken)" }

        $models = Invoke-GuestLoopbackJson -Port ([int]$runtime.proxyPort) -Path '/v1/models' -Headers $proxyHeaders
        $modelCount = @($models.data).Count
        if ($modelCount -lt 1 -or $modelCount -gt 1000) {
            throw 'The local Codex model catalog is unavailable.'
        }
        $gatewayAvailable = Invoke-GuestLoopbackStatusOnly -Port ([int]$runtime.gatewayPort) -Path '/api/listAgents' -Headers $gatewayHeaders -Body '{}'

        $status = Invoke-GuestLoopbackJson -Port ([int]$runtime.viewPort) -Path '/api/codex/status' -Headers $viewHeaders
        $codexSignedIn = $status.account.signedIn -eq $true
        $codexAvailable = [string]$status.connection.mode -ceq 'codex-oauth' -and
            [string]$status.connection.route -ceq 'cliproxyapi-codex-oauth' -and
            [string]$status.usage.availability.state -ceq 'ready'
        $officialMode = [string]$status.officialComputer.mode -ceq 'official'
        $officialConnected = $status.officialComputer.connected -eq $true
        $officialReady = $status.officialComputer.ready -eq $true -and
            [string]$status.officialComputer.state -ceq 'ready'
        $officialErrorAbsent = $null -eq $status.officialComputer.lastError -and
            $status.officialComputer.retrying -ne $true
        if (-not ($codexSignedIn -and $codexAvailable -and $officialMode -and $officialConnected -and $officialReady -and $officialErrorAbsent)) {
            throw 'The authenticated backend did not report the required connected and ready state.'
        }

        $frame = Invoke-GuestLoopbackJson -Port ([int]$runtime.viewPort) -Path '/api/frame?seatKey=sandbox-acceptance-review' -Headers $viewHeaders -MaximumCharacters (34 * 1024 * 1024) -TimeoutSeconds 30
        $png = Test-BoundedPngFrame $frame

        $report = [pscustomobject][ordered]@{
            schemaVersion = 1
            verified = $true
            codexSignedIn = [bool]$codexSignedIn
            codexAvailable = [bool]$codexAvailable
            proxyAvailable = $true
            proxyModelCount = [int]$modelCount
            gatewayAvailable = [bool]$gatewayAvailable
            officialMode = [bool]$officialMode
            officialConnected = [bool]$officialConnected
            officialReady = [bool]$officialReady
            officialErrorAbsent = [bool]$officialErrorAbsent
            frameValid = [bool]$png.valid
            frameWidth = [int]$png.width
            frameHeight = [int]$png.height
            frameByteCount = [int]$png.byteCount
            expectedListenersVerified = [bool]$listeners.expectedListenersVerified
            productListenersLoopbackOnly = [bool]$listeners.productListenersLoopbackOnly
            productProcessCount = [int]$listeners.productProcessCount
            productTcpListenerCount = [int]$listeners.productTcpListenerCount
            productUdpEndpointCount = [int]$listeners.productUdpEndpointCount
        }
        return $report
    } finally {
        if ($null -ne $frame -and $null -ne $frame.PSObject.Properties['screenshotBase64']) {
            $frame.screenshotBase64 = $null
        }
        $frame = $null
        $status = $null
        $models = $null
        $viewHeaders = $null
        $proxyHeaders = $null
        $gatewayHeaders = $null
        $runtime = $null
    }
}

function Get-InstalledPatchInputsDigest {
    param([Parameter(Mandatory = $true)][string]$CodexRoot)

    $inputs = [ordered]@{
        'tools/scripts/patch-app.cjs' = (Join-Path $CodexRoot 'tools\scripts\patch-app.cjs')
        'tools/src/renderer/codex-ui.js' = (Join-Path $CodexRoot 'tools\src\renderer\codex-ui.js')
        'tools/src/renderer/live-seat-component.jsfrag' = (Join-Path $CodexRoot 'tools\src\renderer\live-seat-component.jsfrag')
    }
    $records = New-Object Collections.Generic.List[string]
    foreach ($entry in $inputs.GetEnumerator()) {
        if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
            throw 'A deterministic patch input is missing.'
        }
        $item = Get-Item -LiteralPath $entry.Value -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -le 0 -or $item.Length -gt (16 * 1024 * 1024)) {
            throw 'A deterministic patch input has an invalid file identity or size.'
        }
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash.ToLowerInvariant()
        $records.Add("$($entry.Key)=$hash")
    }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($records -join "`n") + "`n")
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Test-DeterministicPatchedAsar {
    param(
        [Parameter(Mandatory = $true)][string]$VendorSourceAsar,
        [Parameter(Mandatory = $true)][string]$InstalledPatchedAsar,
        [Parameter(Mandatory = $true)][string]$VendorElectronExecutable,
        [Parameter(Mandatory = $true)][string]$PatcherPath,
        [Parameter(Mandatory = $true)][string]$RuntimePath
    )

    foreach ($path in @($VendorSourceAsar, $InstalledPatchedAsar, $VendorElectronExecutable, $PatcherPath, $RuntimePath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'A deterministic patch-verification input is missing.'
        }
        $item = Get-Item -LiteralPath $path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -le 0) {
            throw 'A deterministic patch-verification input is not a regular nonempty file.'
        }
    }

    $verificationRoot = Join-Path ([IO.Path]::GetTempPath()) ("CodexBot-Patch-Verification-{0}" -f [guid]::NewGuid().ToString('N'))
    $created = New-Item -ItemType Directory -Path $verificationRoot
    if (($created.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The deterministic patch-verification directory is unsafe.'
    }
    $expectedAsar = Join-Path $created.FullName 'expected-app.asar'
    $standardOutput = Join-Path $created.FullName 'patcher.stdout.log'
    $standardError = Join-Path $created.FullName 'patcher.stderr.log'
    $hadElectronRunAsNode = Test-Path Env:ELECTRON_RUN_AS_NODE
    $priorElectronRunAsNode = if ($hadElectronRunAsNode) { [string]$env:ELECTRON_RUN_AS_NODE } else { $null }
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        $arguments = @(
            "`"$PatcherPath`"",
            '--source-asar', "`"$VendorSourceAsar`"",
            '--target-asar', "`"$expectedAsar`"",
            '--runtime-config', "`"$RuntimePath`""
        )
        $process = Start-Process -FilePath $VendorElectronExecutable -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $standardOutput -RedirectStandardError $standardError
        if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $expectedAsar -PathType Leaf)) {
            throw 'The deterministic guest patch recomputation failed.'
        }
        $expectedItem = Get-Item -LiteralPath $expectedAsar -Force
        if (($expectedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $expectedItem.Length -le 0) {
            throw 'The deterministic guest patch recomputation produced an invalid archive.'
        }
        $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $expectedItem.FullName).Hash.ToLowerInvariant()
        $installedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InstalledPatchedAsar).Hash.ToLowerInvariant()
        return $expectedHash -ceq $installedHash
    } finally {
        if ($hadElectronRunAsNode) {
            $env:ELECTRON_RUN_AS_NODE = $priorElectronRunAsNode
        } else {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }
        $resolvedVerificationRoot = [IO.Path]::GetFullPath($verificationRoot)
        $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if ($resolvedVerificationRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and
            $resolvedVerificationRoot -ne $resolvedTempRoot -and
            (Test-Path -LiteralPath $resolvedVerificationRoot)) {
            Remove-Item -LiteralPath $resolvedVerificationRoot -Recurse -Force
        }
    }
}

function Test-InstalledCodexRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$VendorInstallRoot,
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$RuntimePath,
        [Parameter(Mandatory = $true)][string]$ExpectedBrandedExecutableSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedPatchInputsSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedVendorManifestSha256
    )

    $result = [ordered]@{
        verified = $false
        manifestFileCount = 0
        actualFileCount = 0
        unchangedPinnedFileCount = 0
        patchedAppAsarPresent = $false
        deterministicPatchVerified = $false
        brandedExecutablePresent = $false
    }
    try {
        $rootItem = Get-Item -LiteralPath $InstallRoot -Force
        if (-not $rootItem.PSIsContainer -or (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            return [pscustomobject]$result
        }
        $root = [IO.Path]::GetFullPath($rootItem.FullName).TrimEnd('\')
        $manifestItem = Get-Item -LiteralPath $ManifestPath -Force
        if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $manifestItem.Length -le 0 -or $manifestItem.Length -gt (4 * 1024 * 1024) -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestItem.FullName).Hash.ToLowerInvariant() -cne $ExpectedVendorManifestSha256.ToLowerInvariant()) {
            return [pscustomobject]$result
        }
        $codexRoot = Split-Path -Parent $root
        if ((Get-InstalledPatchInputsDigest -CodexRoot $codexRoot) -cne $ExpectedPatchInputsSha256.ToLowerInvariant()) {
            return [pscustomobject]$result
        }
        $manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
        if ([int]$manifest.schemaVersion -ne 1 -or
            [string]$manifest.product -cne 'Grok Bot' -or
            [string]$manifest.version -cne '0.18.0' -or
            [string]$manifest.platform -cne 'windows-x64') {
            return [pscustomobject]$result
        }

        $expected = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in @($manifest.files)) {
            $relative = [string]$entry.path
            $hash = ([string]$entry.sha256).ToLowerInvariant()
            if ([string]::IsNullOrWhiteSpace($relative) -or
                $relative.Contains('\') -or
                [IO.Path]::IsPathRooted($relative) -or
                $hash -cnotmatch '^[a-f0-9]{64}$' -or
                $expected.ContainsKey($relative)) {
                return [pscustomobject]$result
            }
            $expected.Add($relative, $entry)
        }
        $result.manifestFileCount = $expected.Count

        $actual = New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -Force) {
            $relative = $item.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                return [pscustomobject]$result
            }
            if ($item.PSIsContainer) { continue }
            if ($actual.ContainsKey($relative)) { return [pscustomobject]$result }
            $actual.Add($relative, $item.FullName)
        }
        $result.actualFileCount = $actual.Count
        if ($actual.Count -ne ($expected.Count + 1) -or
            -not $actual.ContainsKey('Codex Bot.exe')) {
            return [pscustomobject]$result
        }
        foreach ($relative in $actual.Keys) {
            if (-not $expected.ContainsKey($relative) -and $relative -ine 'Codex Bot.exe') {
                return [pscustomobject]$result
            }
        }

        foreach ($relative in $expected.Keys) {
            if (-not $actual.ContainsKey($relative)) { return [pscustomobject]$result }
            $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $actual[$relative]).Hash.ToLowerInvariant()
            $expectedHash = ([string]$expected[$relative].sha256).ToLowerInvariant()
            if ($relative -ieq 'resources/app.asar') {
                if ($actualHash -ceq $expectedHash -or
                    (Get-Item -LiteralPath $actual[$relative]).Length -le 0) {
                    return [pscustomobject]$result
                }
            } else {
                if ($actualHash -cne $expectedHash) { return [pscustomobject]$result }
                $result.unchangedPinnedFileCount++
            }
        }

        $branded = Get-Item -LiteralPath $actual['Codex Bot.exe']
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $branded.FullName).Hash.ToLowerInvariant() -cne $ExpectedBrandedExecutableSha256.ToLowerInvariant() -or
            ([string]$branded.VersionInfo.ProductName).TrimEnd() -cne 'Codex Bot' -or
            ([string]$branded.VersionInfo.FileDescription).TrimEnd() -cne 'Codex Bot') {
            return [pscustomobject]$result
        }
        $result.brandedExecutablePresent = $true

        $vendorSourceAsar = Join-Path $VendorInstallRoot 'resources\app.asar'
        if (-not (Test-Path -LiteralPath $vendorSourceAsar -PathType Leaf) -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $vendorSourceAsar).Hash.ToLowerInvariant() -cne
                ([string]$expected['resources/app.asar'].sha256).ToLowerInvariant()) {
            return [pscustomobject]$result
        }
        $patchVerified = Test-DeterministicPatchedAsar `
            -VendorSourceAsar $vendorSourceAsar `
            -InstalledPatchedAsar $actual['resources/app.asar'] `
            -VendorElectronExecutable $actual['Grok Bot.exe'] `
            -PatcherPath (Join-Path $codexRoot 'tools\scripts\patch-app.cjs') `
            -RuntimePath $RuntimePath
        if (-not $patchVerified) { return [pscustomobject]$result }
        $result.patchedAppAsarPresent = $true
        $result.deterministicPatchVerified = $true
        $result.verified = $true
        return [pscustomobject]$result
    } catch {
        return [pscustomobject]$result
    }
}

function Get-PostInstallReport {
    $codexRoot = Join-Path $env:LOCALAPPDATA 'Programs\Codex Bot'
    $vendorRoot = Join-Path $env:LOCALAPPDATA 'Programs\Grok Bot'
    $runtimePath = Join-Path $env:LOCALAPPDATA 'Codex Bot Bridge\runtime.json'
    $codexExecutable = Join-Path $codexRoot 'app\Codex Bot.exe'
    $vendorExecutable = Join-Path $vendorRoot 'Grok Bot.exe'
    $copiedVendorExecutable = Join-Path $codexRoot 'app\Grok Bot.exe'
    $runtimeVerifier = Join-Path $codexRoot 'tools\integrity\Verify-GrokBotRuntime.ps1'
    $runtimeManifest = Join-Path $codexRoot 'tools\integrity\grok-bot-0.18.0-windows-x64.manifest.json'
    $vendorRuntimeVerified = $false

    if ((Test-Path -LiteralPath $runtimeVerifier -PathType Leaf) -and
        (Test-Path -LiteralPath $runtimeManifest -PathType Leaf) -and
        (Test-Path -LiteralPath $vendorRoot -PathType Container)) {
        try {
            & $runtimeVerifier -InstallRoot $vendorRoot -ManifestPath $runtimeManifest | Out-Null
            $vendorRuntimeVerified = $true
        } catch {
            $vendorRuntimeVerified = $false
        }
    }
    $copiedRuntime = Test-InstalledCodexRuntime `
        -InstallRoot (Join-Path $codexRoot 'app') `
        -VendorInstallRoot $vendorRoot `
        -ManifestPath $runtimeManifest `
        -RuntimePath $runtimePath `
        -ExpectedBrandedExecutableSha256 $ExpectedBrandedExecutableSha256 `
        -ExpectedPatchInputsSha256 $ExpectedPatchInputsSha256 `
        -ExpectedVendorManifestSha256 $ExpectedVendorManifestSha256

    $vendorVersion = $null
    if (Test-Path -LiteralPath $vendorExecutable -PathType Leaf) {
        $vendorVersion = Protect-EvidenceText ([string](Get-Item -LiteralPath $vendorExecutable).VersionInfo.ProductVersion)
    }
    $codexVersion = $null
    if (Test-Path -LiteralPath $codexExecutable -PathType Leaf) {
        $codexVersion = Protect-EvidenceText ([string](Get-Item -LiteralPath $codexExecutable).VersionInfo.ProductVersion)
    }

    $report = [pscustomobject][ordered]@{
        schemaVersion = 1
        codexInstallRootPresent = Test-Path -LiteralPath $codexRoot -PathType Container
        vendorInstallRootPresent = Test-Path -LiteralPath $vendorRoot -PathType Container
        codexExecutablePresent = Test-Path -LiteralPath $codexExecutable -PathType Leaf
        vendorExecutablePresent = Test-Path -LiteralPath $vendorExecutable -PathType Leaf
        copiedVendorExecutablePresent = Test-Path -LiteralPath $copiedVendorExecutable -PathType Leaf
        vendorRuntimeVerified = $vendorRuntimeVerified
        copiedVendorRuntimeVerified = [bool]$copiedRuntime.verified
        copiedRuntimeManifestFileCount = [int]$copiedRuntime.manifestFileCount
        copiedRuntimeActualFileCount = [int]$copiedRuntime.actualFileCount
        copiedRuntimeUnchangedPinnedFileCount = [int]$copiedRuntime.unchangedPinnedFileCount
        patchedAppAsarPresent = [bool]$copiedRuntime.patchedAppAsarPresent
        deterministicPatchVerified = [bool]$copiedRuntime.deterministicPatchVerified
        brandedExecutablePresent = [bool]$copiedRuntime.brandedExecutablePresent
        codexProductVersion = $codexVersion
        vendorProductVersion = $vendorVersion
    }
    $report | Add-Member -NotePropertyName verified -NotePropertyValue (
        $report.codexInstallRootPresent -and
        $report.vendorInstallRootPresent -and
        $report.codexExecutablePresent -and
        $report.vendorExecutablePresent -and
        $report.copiedVendorExecutablePresent -and
        $report.vendorRuntimeVerified -and
        $report.copiedVendorRuntimeVerified
    )
    return $report
}

function Get-AllowedEvidenceNames {
    $names = @(
        'artifact-audit.json',
        'baseline.json',
        'installer-sanitized.log',
        'post-install.json',
        'run-summary.json',
        'evidence-manifest.sha256'
    )
    if ($Scenario -eq 'Interactive') {
        $names += @(
            'backend-verification.json',
            'manual-live-review.json',
            'backend-post-manual-review.json'
        )
    }
    return $names
}

function Assert-BoundedSanitizedEvidence {
    param([switch]$ManifestRequired)

    $allowed = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($name in Get-AllowedEvidenceNames) { $allowed.Add($name) | Out-Null }
    $utf8 = New-Object Text.UTF8Encoding($false, $true)
    $entries = @(Get-ChildItem -LiteralPath $workingEvidenceDirectory -Force)
    if ($entries.Count -lt 2 -or $entries.Count -gt $allowed.Count) {
        throw 'The guest evidence file count is outside the allowlist bound.'
    }
    foreach ($entry in $entries) {
        if ($entry.PSIsContainer -or (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or -not $allowed.Contains($entry.Name)) {
            throw 'Guest evidence contains a directory, reparse point, or non-allowlisted name.'
        }
        $maximumBytes = if ($entry.Name -eq 'installer-sanitized.log') { 8 * 1024 * 1024 } elseif ($entry.Name -eq 'evidence-manifest.sha256') { 64 * 1024 } else { 1024 * 1024 }
        if ($entry.Length -le 0 -or $entry.Length -gt $maximumBytes) {
            throw 'A guest evidence file is empty or exceeds its fixed size bound.'
        }
        try {
            $bytes = [IO.File]::ReadAllBytes($entry.FullName)
            $contents = $utf8.GetString($bytes)
        } catch {
            throw 'A guest evidence file is not strict UTF-8 text.'
        }
        if ($contents.Contains([char]0) -or $contents -match $sensitivePattern) {
            throw 'A guest evidence file failed the sensitive-data scan.'
        }
        if ($entry.Extension -ceq '.json') {
            try {
                $json = $contents | ConvertFrom-Json
            } catch {
                throw 'A JSON evidence file is malformed.'
            }
            if ($null -eq $json -or $json -is [Array]) {
                throw 'A JSON evidence file does not contain one object.'
            }
        }
        $bytes = $null
        $contents = $null
    }
    foreach ($required in @('artifact-audit.json', 'baseline.json', 'run-summary.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $workingEvidenceDirectory $required) -PathType Leaf)) {
            throw 'A required guest evidence record is missing.'
        }
    }
    if ($ManifestRequired -and -not (Test-Path -LiteralPath (Join-Path $workingEvidenceDirectory 'evidence-manifest.sha256') -PathType Leaf)) {
        throw 'The guest evidence manifest is missing.'
    }
}

function Write-EvidenceManifest {
    Assert-BoundedSanitizedEvidence
    $manifestPath = Join-Path $workingEvidenceDirectory 'evidence-manifest.sha256'
    $lines = New-Object Collections.Generic.List[string]
    foreach ($file in Get-ChildItem -LiteralPath $workingEvidenceDirectory -File | Sort-Object Name) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
        $lines.Add("$hash  $($file.Name)")
    }
    Write-Utf8NoBom -LiteralPath $manifestPath -Value (($lines -join "`n") + "`n")
    Assert-BoundedSanitizedEvidence -ManifestRequired
}

function Stop-GuestProductProcessesForEvidenceExport {
    $codexRoot = Join-Path $env:LOCALAPPDATA 'Programs\Codex Bot'
    $disableAlwaysOn = Join-Path $codexRoot 'tools\runtime\Disable-Always-On.ps1'
    if (Test-Path -LiteralPath $disableAlwaysOn -PathType Leaf) {
        try { & $disableAlwaysOn } catch { throw 'Guest product shutdown failed before evidence export.' }
    }
    $paths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in @(
        (Join-Path $codexRoot 'app\Codex Bot.exe'),
        (Join-Path $codexRoot 'app\Grok Bot.exe'),
        (Join-Path $codexRoot 'tools\cliproxyapi\cli-proxy-api.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Grok Bot\Grok Bot.exe')
    )) {
        $paths.Add([IO.Path]::GetFullPath($path)) | Out-Null
    }
    foreach ($process in Get-CimInstance Win32_Process -ErrorAction Stop) {
        if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) { continue }
        try { $processPath = [IO.Path]::GetFullPath([string]$process.ExecutablePath) } catch { continue }
        if ($paths.Contains($processPath)) {
            Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
        }
    }
    Start-Sleep -Milliseconds 500
    foreach ($process in Get-CimInstance Win32_Process -ErrorAction Stop) {
        if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) { continue }
        try { $processPath = [IO.Path]::GetFullPath([string]$process.ExecutablePath) } catch { continue }
        if ($paths.Contains($processPath)) {
            throw 'A guest product process remained active, so evidence export was blocked.'
        }
    }
}

function Export-SanitizedEvidenceToHost {
    if (@(Get-ChildItem -LiteralPath $EvidenceDirectory -Force).Count -ne 0) {
        throw 'The mapped host evidence directory changed during the run; export was blocked.'
    }
    Assert-BoundedSanitizedEvidence -ManifestRequired
    $sourceFiles = @(Get-ChildItem -LiteralPath $workingEvidenceDirectory -File | Sort-Object Name)
    foreach ($source in $sourceFiles) {
        Copy-Item -LiteralPath $source.FullName -Destination (Join-Path $EvidenceDirectory $source.Name)
    }
    $exported = @(Get-ChildItem -LiteralPath $EvidenceDirectory -Force)
    if ($exported.Count -ne $sourceFiles.Count) {
        throw 'The mapped host evidence export is incomplete.'
    }
    foreach ($entry in $exported) {
        if ($entry.PSIsContainer -or (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
            @(Get-AllowedEvidenceNames) -cnotcontains $entry.Name) {
            throw 'The mapped host evidence export contains a non-allowlisted entry.'
        }
        $source = $sourceFiles | Where-Object { $_.Name -ceq $entry.Name } | Select-Object -First 1
        if ($null -eq $source -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $source.FullName).Hash -cne
                (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.FullName).Hash) {
            throw 'A mapped host evidence file does not match its sanitized guest source.'
        }
    }
}

function Invoke-WindowsSandboxAcceptance {
try {
    Assert-ExactMappedDirectory -Actual $ArtifactDirectory -Expected 'C:\CodexBotAcceptance\Artifact' -Label 'ArtifactDirectory'
    Assert-ExactMappedDirectory -Actual $HarnessDirectory -Expected 'C:\CodexBotAcceptance\Harness' -Label 'HarnessDirectory'
    Assert-ExactMappedDirectory -Actual $EvidenceDirectory -Expected 'C:\CodexBotAcceptance\Evidence' -Label 'EvidenceDirectory'
    if (@(Get-ChildItem -LiteralPath $EvidenceDirectory -Force).Count -ne 0) {
        throw 'The writable evidence directory is not empty; refusing to mix separate acceptance runs.'
    }
    $workingEvidence = New-Item -ItemType Directory -Path $workingEvidenceDirectory
    if (($workingEvidence.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The guest-private evidence directory unexpectedly resolved to a reparse point.'
    }

    $audit = Get-ArtifactAudit
    $summary.artifactAudit = 'passed'
    Write-JsonEvidence -Name 'artifact-audit.json' -Value $audit

    $baseline = Get-CleanBaselineReport
    Write-JsonEvidence -Name 'baseline.json' -Value $baseline
    if (-not $baseline.clean) {
        throw 'The Sandbox baseline contains Codex Bot, Grok Bot, or Cursor installation/state indicators. The installer was not executed.'
    }
    $summary.cleanBaseline = $true

    $installerPath = Join-Path $ArtifactDirectory $ExpectedInstallerName
    if ($Scenario -eq 'Interactive') {
        Write-Host ''
        Write-Host 'Codex Bot interactive acceptance (manual decisions only)'
        Write-Host '1. In Setup, select the option to download and install pinned Grok Bot 0.18.0.'
        Write-Host '2. Review and handle any SmartScreen or permission decision yourself.'
        Write-Host '3. Keep Launch Codex Bot selected, then complete Setup.'
        Write-Host 'The harness does not click Setup, SmartScreen, permissions, or authentication UI.'
        Write-Host ''
        $installerProcess = Start-Process -FilePath $installerPath -ArgumentList @("/LOG=$rawInstallerLog") -Wait -PassThru
    } else {
        $silentArguments = @(
            '/VERYSILENT',
            '/SUPPRESSMSGBOXES',
            '/NORESTART',
            '/SP-',
            '/BOOTSTRAPGROKBOT=1',
            "/LOG=$rawInstallerLog"
        )
        $installerProcess = Start-Process -FilePath $installerPath -ArgumentList $silentArguments -Wait -PassThru -WindowStyle Hidden
    }
    $summary.installerExitCode = [int]$installerProcess.ExitCode
    Copy-SanitizedInstallerLog
    if ($installerProcess.ExitCode -ne 0) {
        throw "Installer returned exit code $($installerProcess.ExitCode)."
    }

    $postInstall = Get-PostInstallReport
    Write-JsonEvidence -Name 'post-install.json' -Value $postInstall
    if (-not $postInstall.verified) {
        throw 'Post-install verification did not prove both the separate vendor installation and the complete copied runtime.'
    }
    $summary.postInstallVerified = $true

    if ($Scenario -eq 'Interactive') {
        Write-Host ''
        Write-Host 'Authentication remains entirely manual and is never recorded by this harness.'
        Write-Host 'In Codex Bot, complete the Codex sign-in using the app UI.'
        [void](Read-Host 'After you have reviewed the connected Codex state, press Enter (do not type credentials here)')
        Write-Host 'In Settings, choose the Cursor vendor-computer sign-in and complete it at cursor.com.'
        [void](Read-Host 'After you have reviewed the connected vendor-computer state, press Enter (do not type credentials here)')
        $summary.operatorAuthenticationReview = 'operator-attested'

        Write-Host 'Verifying signed-in Codex availability, official readiness, a bounded PNG frame, and loopback-only product listeners...'
        $backend = Get-GuestBackendVerification
        Write-JsonEvidence -Name 'backend-verification.json' -Value $backend
        if (-not $backend.verified) {
            throw 'The authenticated backend verification did not pass.'
        }
        $summary.backendHealthVerified = $true

        Write-Host ''
        Write-Host 'Live direct-navigation review (manual only):'
        Write-Host '1. In a Codex Bot chat, send: Go directly to https://x.com. Use CTRL+L and verify the final hostname; do not use any page search field.'
        Write-Host '2. Review and decide any chat approval card yourself. The harness never clicks Allow or Deny.'
        Write-Host '3. Inspect the shared computer and confirm it opened x.com directly, not a Wikipedia or other site search-results page.'
        [void](Read-Host 'After you have personally verified direct x.com navigation, press Enter')
        $summary.directNavigationReview = $true

        Write-Host ''
        Write-Host 'Live takeover-layout review (manual only):'
        Write-Host '1. Click Take control and confirm the computer expands to a large app-level view.'
        Write-Host '2. Click Release control and confirm it returns to the small chat-side preview.'
        Write-Host '3. Do not enter credentials or change permission settings during this layout check.'
        [void](Read-Host 'After you have personally verified expand and release, press Enter')
        $summary.takeoverReview = $true
        $manualReview = [pscustomobject][ordered]@{
            schemaVersion = 1
            directNavigationOperatorAttested = $true
            directHostnameOperatorReviewed = $true
            takeoverExpansionOperatorAttested = $true
            takeoverReleaseOperatorAttested = $true
            automatedUiInput = $false
        }
        Write-JsonEvidence -Name 'manual-live-review.json' -Value $manualReview

        $backendAfterManualReview = Get-GuestBackendVerification
        Write-JsonEvidence -Name 'backend-post-manual-review.json' -Value $backendAfterManualReview
        if (-not $backendAfterManualReview.verified) {
            throw 'The authenticated backend did not remain healthy after the manual live review.'
        }
    }

    $summary.status = 'passed'
    $summary.error = $null
    $scriptExitCode = 0
} catch {
    $summary.status = 'failed'
    $summary.error = Protect-EvidenceText ([string]$_.Exception.Message)
    $scriptExitCode = 1
} finally {
    try {
        if (Test-Path -LiteralPath $workingEvidenceDirectory -PathType Container) {
            Write-JsonEvidence -Name 'run-summary.json' -Value ([pscustomobject]$summary)
            Write-EvidenceManifest
            Stop-GuestProductProcessesForEvidenceExport
            Export-SanitizedEvidenceToHost
        }
    } catch {
        $scriptExitCode = 1
        Write-Error (Protect-EvidenceText ([string]$_.Exception.Message)) -ErrorAction Continue
    }
    if (Test-Path -LiteralPath $rawInstallerLog -PathType Leaf) {
        Remove-Item -LiteralPath $rawInstallerLog -Force -ErrorAction SilentlyContinue
    }
}
    return $scriptExitCode
}

if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-WindowsSandboxAcceptance)
}
