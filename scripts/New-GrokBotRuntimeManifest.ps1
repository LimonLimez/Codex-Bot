param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$expectedProduct = 'Grok Bot'
$expectedVersion = '0.18.0'
$expectedPlatform = 'windows-x64'
$expectedSignerSubject = 'CN="Anysphere, Inc.", O="Anysphere, Inc.", L=San Francisco, S=California, C=US'
$expectedSignerThumbprint = '67E878CBE262D364A6D059B77DAC002E2C064F0E'
$expectedFileCount = 657
$expectedAggregateLength = 496010226L
$expectedAppAsarSha256 = '38E85C0E5042C0257DB7925E1E55709D6D155D90D92FE26AD654127D509766E0'
$expectedExecutableSha256 = '86719C9DCBFC580B7BC29ECE62302401A7622AE577E2CFF42B4C525DB674F1CA'
$expectedUninstallerSha256 = '4E4045884146E852BEB42B22D95C509D6A5439E362236410EB5D45CC9CFE380A'

$rootItem = Get-Item -LiteralPath $InstallRoot -Force
if (-not $rootItem.PSIsContainer) { throw "The Grok Bot path is not a directory: $InstallRoot" }
if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The Grok Bot root cannot be a reparse point.'
}
$root = [IO.Path]::GetFullPath($rootItem.FullName).TrimEnd('\')
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
if ($outputFullPath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The manifest output must be outside the clean Grok Bot installation tree.'
}
$vendorExe = Join-Path $root 'Grok Bot.exe'
$appAsar = Join-Path $root 'resources\app.asar'
$uninstaller = Join-Path $root 'Uninstall Grok Bot.exe'
if (-not (Test-Path -LiteralPath $vendorExe -PathType Leaf) -or
    -not (Test-Path -LiteralPath $appAsar -PathType Leaf) -or
    -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw 'The clean install is missing Grok Bot.exe, resources\app.asar, or Uninstall Grok Bot.exe.'
}

$exe = Get-Item -LiteralPath $vendorExe -Force
if ([string]$exe.VersionInfo.FileVersion -cne $expectedVersion -or
    [string]$exe.VersionInfo.ProductVersion -cne "$expectedVersion.0" -or
    [string]$exe.VersionInfo.ProductName -cne $expectedProduct) {
    throw 'The clean install executable is not Grok Bot 0.18.0.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $vendorExe
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) {
    throw "Grok Bot.exe does not have a valid Authenticode signature (status: $($signature.Status))."
}
if ([string]$signature.SignerCertificate.Subject -cne $expectedSignerSubject -or
    ([string]$signature.SignerCertificate.Thumbprint).ToUpperInvariant() -cne $expectedSignerThumbprint) {
    throw 'Grok Bot.exe is not signed by the exact reviewed 0.18.0 signer.'
}

$byRelativePath = @{}
$pending = New-Object System.Collections.Generic.Stack[string]
$pending.Push($root)
while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
        $relative = $item.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "The clean Grok Bot tree contains a reparse point: '$relative'."
        }
        if ($item.PSIsContainer) {
            $pending.Push($item.FullName)
        } else {
            if ($byRelativePath.ContainsKey($relative.ToLowerInvariant())) {
                throw "The clean Grok Bot tree contains a case-insensitive duplicate path: '$relative'."
            }
            $byRelativePath.Add($relative.ToLowerInvariant(), [pscustomobject]@{
                Path = $relative
                FullName = $item.FullName
                Length = [long]$item.Length
            })
        }
    }
}

if ($byRelativePath.Count -ne $expectedFileCount) {
    throw "The clean Grok Bot tree has the wrong file count: expected $expectedFileCount, got $($byRelativePath.Count)."
}
$aggregateLength = [long]0
foreach ($entry in $byRelativePath.Values) { $aggregateLength += [long]$entry.Length }
if ($aggregateLength -ne $expectedAggregateLength) {
    throw "The clean Grok Bot tree has the wrong aggregate length: expected $expectedAggregateLength bytes, got $aggregateLength."
}
foreach ($criticalPin in @(
    @('resources/app.asar', $expectedAppAsarSha256),
    @('Grok Bot.exe', $expectedExecutableSha256),
    @('Uninstall Grok Bot.exe', $expectedUninstallerSha256)
)) {
    $criticalEntry = $byRelativePath[$criticalPin[0].ToLowerInvariant()]
    $criticalHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $criticalEntry.FullName).Hash.ToUpperInvariant()
    if ($criticalHash -cne $criticalPin[1]) {
        throw "The clean Grok Bot tree does not match the reviewed critical-file pin: $($criticalPin[0])."
    }
}

$paths = [string[]]@($byRelativePath.Values | ForEach-Object { $_.Path })
[Array]::Sort($paths, [StringComparer]::Ordinal)
$files = foreach ($relative in $paths) {
    $entry = $byRelativePath[$relative.ToLowerInvariant()]
    [ordered]@{
        path = $relative
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.FullName).Hash.ToLowerInvariant()
    }
}

$manifest = [ordered]@{
    schemaVersion = 1
    product = $expectedProduct
    version = $expectedVersion
    platform = $expectedPlatform
    signer = [ordered]@{
        subject = $expectedSignerSubject
        thumbprint = $expectedSignerThumbprint
    }
    files = @($files)
}
$outputDirectory = Split-Path -Parent $outputFullPath
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
    throw "The output directory does not exist: $outputDirectory"
}
$json = $manifest | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($outputFullPath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
[pscustomobject]@{
    ok = $true
    outputPath = $outputFullPath
    fileCount = @($files).Count
    appAsarSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $appAsar).Hash.ToUpperInvariant()
    signerThumbprint = ([string]$signature.SignerCertificate.Thumbprint).ToUpperInvariant()
}
