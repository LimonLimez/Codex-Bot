param(
    [string]$InstallerPath = '',
    [string]$SidecarPath = '',
    [string]$ExpectedSha256 = '',
    [string]$ExpectedBrandedExecutableSha256 = '',
    [string]$OutputRoot = '',
    [switch]$DryRun,
    [ValidateSet('None', 'Interactive', 'Silent')]
    [string]$LaunchScenario = 'None'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $encoding = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($LiteralPath, $Value, $encoding)
}

function Get-StrictFile {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        throw "$Label is not a file: $LiteralPath"
    }
    $item = Get-Item -LiteralPath $LiteralPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label must not be a symbolic link or other reparse point: $LiteralPath"
    }
    return $item
}

function Get-ReviewedPatchInputsDigest {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $inputs = [ordered]@{
        'tools/scripts/patch-app.cjs' = (Join-Path $ProjectRoot 'scripts\patch-app.cjs')
        'tools/src/renderer/codex-ui.js' = (Join-Path $ProjectRoot 'src\renderer\codex-ui.js')
        'tools/src/renderer/live-seat-component.jsfrag' = (Join-Path $ProjectRoot 'src\renderer\live-seat-component.jsfrag')
    }
    $records = New-Object Collections.Generic.List[string]
    foreach ($entry in $inputs.GetEnumerator()) {
        Get-StrictFile -LiteralPath $entry.Value -Label "Reviewed patch input '$($entry.Key)'" | Out-Null
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.Value).Hash.ToLowerInvariant()
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

function Test-DevelopmentInstallerArtifact {
    param(
        [Parameter(Mandatory = $true)][string]$InstallerPath,
        [Parameter(Mandatory = $true)][string]$SidecarPath,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedRevision,
        [object]$VersionInfo = $null
    )

    if ($ExpectedSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'ExpectedSha256 must be an independently reviewed 64-character SHA-256 value.'
    }
    if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw "The expected package version is invalid: $ExpectedVersion"
    }
    if ($ExpectedRevision -notmatch '^[A-Fa-f0-9]{7,12}$') {
        throw "The expected Git revision is invalid: $ExpectedRevision"
    }

    $installer = Get-StrictFile -LiteralPath $InstallerPath -Label 'Installer'
    $sidecar = Get-StrictFile -LiteralPath $SidecarPath -Label 'Checksum sidecar'
    if ($installer.Length -le 0) {
        throw 'The installer is empty.'
    }
    if ($sidecar.Length -le 0 -or $sidecar.Length -gt 1024) {
        throw 'The checksum sidecar must be between 1 and 1024 bytes.'
    }

    $escapedVersion = [Regex]::Escape($ExpectedVersion)
    $namePattern = '^CodexBot-Setup-' + $escapedVersion + '-DEVELOPMENT-(?<timestamp>\d{8}T\d{9}Z)-(?<revision>[A-Fa-f0-9]{7,12})\.exe$'
    if ($installer.Name -cnotmatch $namePattern) {
        throw "Only the current versioned DEVELOPMENT installer is accepted: $($installer.Name)"
    }
    $buildTimestamp = $Matches['timestamp']
    $artifactRevision = $Matches['revision'].ToLowerInvariant()
    if ($artifactRevision -cne $ExpectedRevision.ToLowerInvariant()) {
        throw "The DEVELOPMENT installer revision '$artifactRevision' does not match current Git revision '$($ExpectedRevision.ToLowerInvariant())'."
    }
    if ($sidecar.Name -cne "$($installer.Name).sha256") {
        throw "The sidecar name must be exactly '$($installer.Name).sha256'."
    }

    $sidecarBytes = [IO.File]::ReadAllBytes($sidecar.FullName)
    foreach ($byte in $sidecarBytes) {
        if (($byte -gt 127) -or ($byte -eq 0)) {
            throw 'The checksum sidecar must contain plain ASCII text only.'
        }
    }
    $sidecarText = [Text.Encoding]::ASCII.GetString($sidecarBytes)
    if ($sidecarText.EndsWith("`r`n")) {
        $sidecarText = $sidecarText.Substring(0, $sidecarText.Length - 2)
    } elseif ($sidecarText.EndsWith("`n")) {
        $sidecarText = $sidecarText.Substring(0, $sidecarText.Length - 1)
    }
    if ($sidecarText.Contains("`r") -or $sidecarText.Contains("`n")) {
        throw 'The checksum sidecar must contain exactly one checksum record.'
    }

    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName).Hash.ToLowerInvariant()
    $expectedHash = $ExpectedSha256.ToLowerInvariant()
    if ($actualHash -cne $expectedHash) {
        throw "Installer SHA-256 does not match the independently reviewed value (expected $expectedHash, got $actualHash)."
    }
    $expectedSidecar = "$actualHash  $($installer.Name)"
    if ($sidecarText -cne $expectedSidecar) {
        throw 'The checksum sidecar is not the exact canonical record for this installer.'
    }

    if ($null -eq $VersionInfo) {
        $VersionInfo = $installer.VersionInfo
    }
    $productName = ([string]$VersionInfo.ProductName).TrimEnd()
    $fileDescription = ([string]$VersionInfo.FileDescription).TrimEnd()
    $productVersion = ([string]$VersionInfo.ProductVersion).TrimEnd()
    if ($productName -cne 'Codex Bot DEVELOPMENT TEST BUILD') {
        throw 'The installer PE metadata is not labeled Codex Bot DEVELOPMENT TEST BUILD.'
    }
    if ($fileDescription -cne 'Codex Bot DEVELOPMENT TEST installer - DO NOT PUBLISH') {
        throw 'The installer PE metadata is missing the DEVELOPMENT/DO NOT PUBLISH description.'
    }
    if ($productVersion -cne "$ExpectedVersion DEVELOPMENT TEST BUILD") {
        throw 'The installer PE product version does not match the current DEVELOPMENT version.'
    }

    $signatureStatus = 'Unavailable'
    if (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue) {
        try {
            $signatureStatus = [string](Get-AuthenticodeSignature -LiteralPath $installer.FullName).Status
        } catch {
            $signatureStatus = 'Unavailable'
        }
    }

    return [pscustomobject][ordered]@{
        auditPolicy = 'codex-bot-development-sandbox-v1'
        audited = $true
        name = $installer.Name
        length = [int64]$installer.Length
        sha256 = $actualHash
        version = $ExpectedVersion
        buildTimestampUtc = $buildTimestamp
        gitRevision = $artifactRevision
        productName = $productName
        productVersion = $productVersion
        fileDescription = $fileDescription
        signatureStatus = $signatureStatus
    }
}

function Get-WindowsSandboxReadiness {
    $windowsRoot = if ([string]::IsNullOrWhiteSpace($env:WINDIR)) { 'C:\Windows' } else { $env:WINDIR }
    $executable = Join-Path $windowsRoot 'System32\WindowsSandbox.exe'
    $isWindowsPlatform = $true
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $isWindowsVariable = Get-Variable -Name IsWindows -ErrorAction SilentlyContinue
        $isWindowsPlatform = $null -ne $isWindowsVariable -and [bool]$isWindowsVariable.Value
    }
    if (-not $isWindowsPlatform) {
        return [pscustomobject]@{ ready = $false; executable = $executable; reason = 'Windows is required.' }
    }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        return [pscustomobject]@{ ready = $false; executable = $executable; reason = 'WindowsSandbox.exe is unavailable.' }
    }

    try {
        $feature = Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='Containers-DisposableClientVM'" -ErrorAction Stop
        if ($null -eq $feature -or [int]$feature.InstallState -ne 1) {
            return [pscustomobject]@{ ready = $false; executable = $executable; reason = 'The Containers-DisposableClientVM feature is not enabled.' }
        }
    } catch {
        return [pscustomobject]@{ ready = $false; executable = $executable; reason = 'Windows Sandbox feature state could not be proven.' }
    }

    return [pscustomobject]@{ ready = $true; executable = $executable; reason = 'Ready' }
}

function ConvertTo-XmlEscapedText {
    param([Parameter(Mandatory = $true)][string]$Value)
    return [Security.SecurityElement]::Escape($Value)
}

function New-SandboxConfigurationXml {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('Interactive', 'Silent')][string]$Scenario,
        [Parameter(Mandatory = $true)][string]$ArtifactHostFolder,
        [Parameter(Mandatory = $true)][string]$HarnessHostFolder,
        [Parameter(Mandatory = $true)][string]$EvidenceHostFolder,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedInstallerName,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedRevision,
        [Parameter(Mandatory = $true)][string]$ExpectedBrandedExecutableSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedPatchInputsSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedVendorManifestSha256
    )

    $artifactHost = ConvertTo-XmlEscapedText ([IO.Path]::GetFullPath($ArtifactHostFolder))
    $harnessHost = ConvertTo-XmlEscapedText ([IO.Path]::GetFullPath($HarnessHostFolder))
    $evidenceHost = ConvertTo-XmlEscapedText ([IO.Path]::GetFullPath($EvidenceHostFolder))
    $command = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\CodexBotAcceptance\Harness\Invoke-WindowsSandboxAcceptance.ps1" -Scenario "' + $Scenario + '" -ArtifactDirectory "C:\CodexBotAcceptance\Artifact" -HarnessDirectory "C:\CodexBotAcceptance\Harness" -EvidenceDirectory "C:\CodexBotAcceptance\Evidence" -ExpectedSha256 "' + $ExpectedSha256 + '" -ExpectedInstallerName "' + $ExpectedInstallerName + '" -ExpectedVersion "' + $ExpectedVersion + '" -ExpectedRevision "' + $ExpectedRevision + '" -ExpectedBrandedExecutableSha256 "' + $ExpectedBrandedExecutableSha256 + '" -ExpectedPatchInputsSha256 "' + $ExpectedPatchInputsSha256 + '" -ExpectedVendorManifestSha256 "' + $ExpectedVendorManifestSha256 + '"'
    $escapedCommand = ConvertTo-XmlEscapedText $command

    return @"
<?xml version="1.0" encoding="utf-8"?>
<Configuration>
  <vGPU>Disable</vGPU>
  <Networking>Enable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ProtectedClient>Enable</ProtectedClient>
  <MemoryInMB>8192</MemoryInMB>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$artifactHost</HostFolder>
      <SandboxFolder>C:\CodexBotAcceptance\Artifact</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$harnessHost</HostFolder>
      <SandboxFolder>C:\CodexBotAcceptance\Harness</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$evidenceHost</HostFolder>
      <SandboxFolder>C:\CodexBotAcceptance\Evidence</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>$escapedCommand</Command>
  </LogonCommand>
</Configuration>
"@
}

function New-EmptyOutputRoot {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $fullPath = [IO.Path]::GetFullPath($LiteralPath)
    if ($fullPath.StartsWith('\\', [StringComparison]::Ordinal) -or $fullPath -notmatch '^[A-Za-z]:\\') {
        throw 'OutputRoot must be on a local drive, not a UNC or provider path.'
    }
    if ($fullPath -eq [IO.Path]::GetPathRoot($fullPath)) {
        throw 'OutputRoot must not be a drive root.'
    }
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($fullPath))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed) {
        throw 'OutputRoot must be on a fixed local drive.'
    }
    if (Test-Path -LiteralPath $fullPath) {
        throw "OutputRoot already exists; use a new empty path so evidence cannot be mixed across runs: $fullPath"
    }

    $ancestor = Split-Path -Parent $fullPath
    while (-not (Test-Path -LiteralPath $ancestor)) {
        $next = Split-Path -Parent $ancestor
        if ([string]::IsNullOrWhiteSpace($next) -or $next -eq $ancestor) {
            throw "Could not resolve a safe existing parent for OutputRoot: $fullPath"
        }
        $ancestor = $next
    }
    $ancestorItem = Get-Item -LiteralPath $ancestor -Force
    $checkedAncestor = $ancestorItem
    while ($null -ne $checkedAncestor) {
        if ($checkedAncestor -isnot [IO.DirectoryInfo] -or
            (($checkedAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'Every existing OutputRoot ancestor must be a real local directory, not a reparse point.'
        }
        $checkedAncestor = $checkedAncestor.Parent
    }

    $created = New-Item -ItemType Directory -Path $fullPath
    if (($created.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The created OutputRoot unexpectedly resolved to a reparse point.'
    }
    return $created.FullName
}

function Invoke-HarnessGeneration {
    param(
        [Parameter(Mandatory = $true)][string]$InstallerPath,
        [string]$SidecarPath,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedBrandedExecutableSha256,
        [string]$OutputRoot,
        [switch]$DryRun,
        [ValidateSet('None', 'Interactive', 'Silent')][string]$LaunchScenario = 'None'
    )

    if ($DryRun -and $LaunchScenario -ne 'None') {
        throw 'DryRun cannot be combined with LaunchScenario.'
    }
    if ($ExpectedBrandedExecutableSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'ExpectedBrandedExecutableSha256 must be an independently reviewed 64-character SHA-256 value.'
    }

    $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $packagePath = Join-Path $projectRoot 'package.json'
    $vendorManifestPath = Join-Path $projectRoot 'assets\grok-bot-0.18.0-windows-x64.manifest.json'
    $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
    $version = [string]$package.version
    Get-StrictFile -LiteralPath $vendorManifestPath -Label 'Reviewed vendor runtime manifest' | Out-Null
    $vendorManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $vendorManifestPath).Hash.ToLowerInvariant()
    $patchInputsSha256 = Get-ReviewedPatchInputsDigest -ProjectRoot $projectRoot
    if ([string]::IsNullOrWhiteSpace($SidecarPath)) {
        $SidecarPath = "$InstallerPath.sha256"
    }

    $revision = [string](& git -C $projectRoot rev-parse --short=12 HEAD)
    if ($LASTEXITCODE -ne 0 -or $revision.Trim() -notmatch '^[A-Fa-f0-9]{7,12}$') {
        throw 'The current Git revision could not be proven.'
    }
    $revision = $revision.Trim().ToLowerInvariant()

    $audit = Test-DevelopmentInstallerArtifact `
        -InstallerPath $InstallerPath `
        -SidecarPath $SidecarPath `
        -ExpectedSha256 $ExpectedSha256 `
        -ExpectedVersion $version `
        -ExpectedRevision $revision

    if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
        $stamp = [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmssfff'Z'", [Globalization.CultureInfo]::InvariantCulture)
        $OutputRoot = Join-Path (Join-Path ([IO.Path]::GetTempPath()) 'CodexBot-Sandbox-Acceptance') "$stamp-$($audit.sha256.Substring(0, 12))"
    }
    $resolvedOutput = New-EmptyOutputRoot -LiteralPath $OutputRoot
    $artifactRoot = New-Item -ItemType Directory -Path (Join-Path $resolvedOutput 'artifact')
    $harnessRoot = New-Item -ItemType Directory -Path (Join-Path $resolvedOutput 'harness')
    $evidenceRoot = New-Item -ItemType Directory -Path (Join-Path $resolvedOutput 'evidence')
    $interactiveEvidence = New-Item -ItemType Directory -Path (Join-Path $evidenceRoot.FullName 'interactive')
    $silentEvidence = New-Item -ItemType Directory -Path (Join-Path $evidenceRoot.FullName 'silent')
    foreach ($directory in @($artifactRoot, $harnessRoot, $evidenceRoot, $interactiveEvidence, $silentEvidence)) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to map a reparse-point directory: $($directory.FullName)"
        }
    }

    $stagedInstaller = Join-Path $artifactRoot.FullName $audit.name
    $stagedSidecar = "$stagedInstaller.sha256"
    Copy-Item -LiteralPath ([IO.Path]::GetFullPath($InstallerPath)) -Destination $stagedInstaller
    Copy-Item -LiteralPath ([IO.Path]::GetFullPath($SidecarPath)) -Destination $stagedSidecar
    $stagedAudit = Test-DevelopmentInstallerArtifact `
        -InstallerPath $stagedInstaller `
        -SidecarPath $stagedSidecar `
        -ExpectedSha256 $ExpectedSha256 `
        -ExpectedVersion $version `
        -ExpectedRevision $revision
    $stagedAudit | Add-Member -NotePropertyName brandedExecutableSha256 -NotePropertyValue $ExpectedBrandedExecutableSha256.ToLowerInvariant()
    $stagedAudit | Add-Member -NotePropertyName patchInputsSha256 -NotePropertyValue $patchInputsSha256
    $stagedAudit | Add-Member -NotePropertyName vendorManifestSha256 -NotePropertyValue $vendorManifestSha256

    $runnerSource = Join-Path $PSScriptRoot 'Invoke-WindowsSandboxAcceptance.ps1'
    Get-StrictFile -LiteralPath $runnerSource -Label 'Sandbox runner' | Out-Null
    Copy-Item -LiteralPath $runnerSource -Destination (Join-Path $harnessRoot.FullName 'Invoke-WindowsSandboxAcceptance.ps1')
    $auditJson = $stagedAudit | ConvertTo-Json -Depth 4
    Write-Utf8NoBom -LiteralPath (Join-Path $harnessRoot.FullName 'artifact-audit.json') -Value ($auditJson + "`n")

    $artifactEntries = @(Get-ChildItem -LiteralPath $artifactRoot.FullName -Force)
    if ($artifactEntries.Count -ne 2 -or @($artifactEntries | Where-Object { $_.PSIsContainer }).Count -ne 0) {
        throw 'The staged artifact mapping must contain exactly the audited installer and its sidecar.'
    }

    $interactiveConfig = Join-Path $resolvedOutput 'CodexBot-Acceptance-Interactive.wsb'
    $silentConfig = Join-Path $resolvedOutput 'CodexBot-Acceptance-Silent.wsb'
    $interactiveXml = New-SandboxConfigurationXml -Scenario Interactive -ArtifactHostFolder $artifactRoot.FullName -HarnessHostFolder $harnessRoot.FullName -EvidenceHostFolder $interactiveEvidence.FullName -ExpectedSha256 $audit.sha256 -ExpectedInstallerName $audit.name -ExpectedVersion $version -ExpectedRevision $revision -ExpectedBrandedExecutableSha256 $ExpectedBrandedExecutableSha256.ToLowerInvariant() -ExpectedPatchInputsSha256 $patchInputsSha256 -ExpectedVendorManifestSha256 $vendorManifestSha256
    $silentXml = New-SandboxConfigurationXml -Scenario Silent -ArtifactHostFolder $artifactRoot.FullName -HarnessHostFolder $harnessRoot.FullName -EvidenceHostFolder $silentEvidence.FullName -ExpectedSha256 $audit.sha256 -ExpectedInstallerName $audit.name -ExpectedVersion $version -ExpectedRevision $revision -ExpectedBrandedExecutableSha256 $ExpectedBrandedExecutableSha256.ToLowerInvariant() -ExpectedPatchInputsSha256 $patchInputsSha256 -ExpectedVendorManifestSha256 $vendorManifestSha256
    [xml]$interactiveXml | Out-Null
    [xml]$silentXml | Out-Null
    Write-Utf8NoBom -LiteralPath $interactiveConfig -Value $interactiveXml
    Write-Utf8NoBom -LiteralPath $silentConfig -Value $silentXml

    $readiness = Get-WindowsSandboxReadiness
    if ($LaunchScenario -ne 'None') {
        if (-not $readiness.ready) {
            throw "Windows Sandbox launch is blocked: $($readiness.reason)"
        }
        $configuration = if ($LaunchScenario -eq 'Interactive') { $interactiveConfig } else { $silentConfig }
        Start-Process -FilePath $readiness.executable -ArgumentList @("`"$configuration`"") | Out-Null
    }

    return [pscustomobject][ordered]@{
        mode = if ($LaunchScenario -ne 'None') { 'launched' } elseif ($DryRun) { 'dry-run' } else { 'generated' }
        outputRoot = $resolvedOutput
        installer = $audit.name
        sha256 = $audit.sha256
        brandedExecutableSha256 = $ExpectedBrandedExecutableSha256.ToLowerInvariant()
        patchInputsSha256 = $patchInputsSha256
        vendorManifestSha256 = $vendorManifestSha256
        audited = $audit.audited
        sandboxReady = $readiness.ready
        sandboxReadiness = $readiness.reason
        interactiveConfiguration = $interactiveConfig
        silentConfiguration = $silentConfig
        launchedScenario = $LaunchScenario
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
        throw 'InstallerPath is required.'
    }
    if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
        throw 'ExpectedSha256 is required and must come from the independent artifact audit.'
    }
    if ([string]::IsNullOrWhiteSpace($ExpectedBrandedExecutableSha256)) {
        throw 'ExpectedBrandedExecutableSha256 is required and must come from the independent installed-entrypoint audit.'
    }
    Invoke-HarnessGeneration @PSBoundParameters
}
