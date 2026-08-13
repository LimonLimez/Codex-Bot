param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,

    [Parameter(Mandatory = $true)]
    [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
$expectedSchemaVersion = 1
$expectedProduct = 'Grok Bot'
$expectedVersion = '0.16.0'
$expectedPlatform = 'windows-x64'
$expectedSignerSubject = 'CN="Anysphere, Inc.", O="Anysphere, Inc.", L=San Francisco, S=California, C=US'
$expectedSignerThumbprint = '786DA5811DB0A4B3C1AD4754B4CC06BF76C97827'

function Get-RequiredProperty($Value, [string]$Name) {
    if ($null -eq $Value -or $null -eq $Value.PSObject.Properties[$Name]) {
        throw "The supported-runtime manifest is missing '$Name'."
    }
    return $Value.PSObject.Properties[$Name].Value
}

function Get-CanonicalRelativePath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains('\') -or [IO.Path]::IsPathRooted($Value)) {
        throw "The supported-runtime manifest contains an invalid relative path: '$Value'."
    }
    $segments = @($Value.Split('/'))
    if ($segments.Count -eq 0 -or @($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -ne 0) {
        throw "The supported-runtime manifest contains an invalid relative path: '$Value'."
    }
    return [string]::Join('/', $segments)
}

function Get-TreeEntries([string]$Root) {
    $entries = New-Object System.Collections.Generic.List[object]
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            $relative = $item.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "The selected Grok Bot tree contains a reparse point: '$relative'."
            }
            if ($item.PSIsContainer) {
                $pending.Push($item.FullName)
            } else {
                $entries.Add([pscustomobject]@{ Path = $relative; FullName = $item.FullName })
            }
        }
    }
    return @($entries | ForEach-Object { $_ })
}

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "The supported-runtime manifest is missing: $ManifestPath"
}

$rootItem = Get-Item -LiteralPath $InstallRoot -Force
if (-not $rootItem.PSIsContainer) { throw "The selected Grok Bot path is not a directory: $InstallRoot" }
if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The selected Grok Bot root cannot be a reparse point.'
}
$root = [IO.Path]::GetFullPath($rootItem.FullName).TrimEnd('\')

try {
    $manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
} catch {
    throw 'The supported-runtime manifest is not valid JSON.'
}
if ($null -eq $manifest -or $manifest -is [System.Array]) {
    throw 'The supported-runtime manifest must contain one object.'
}
if ([int](Get-RequiredProperty $manifest 'schemaVersion') -ne $expectedSchemaVersion -or
    [string](Get-RequiredProperty $manifest 'product') -cne $expectedProduct -or
    [string](Get-RequiredProperty $manifest 'version') -cne $expectedVersion -or
    [string](Get-RequiredProperty $manifest 'platform') -cne $expectedPlatform) {
    throw 'The supported-runtime manifest identity is not the pinned Grok Bot 0.16.0 Windows x64 identity.'
}

$signer = Get-RequiredProperty $manifest 'signer'
$manifestSignerSubject = [string](Get-RequiredProperty $signer 'subject')
$manifestSignerThumbprint = ([string](Get-RequiredProperty $signer 'thumbprint')).ToUpperInvariant()
if ($manifestSignerSubject -cne $expectedSignerSubject -or $manifestSignerThumbprint -cne $expectedSignerThumbprint) {
    throw 'The supported-runtime manifest signer identity does not match the reviewed pinned signer.'
}

$manifestFiles = @(Get-RequiredProperty $manifest 'files')
if ($manifestFiles.Count -eq 0) { throw 'The supported-runtime manifest contains no files.' }
$expectedFiles = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
$previousPath = $null
foreach ($entry in $manifestFiles) {
    $relative = Get-CanonicalRelativePath ([string](Get-RequiredProperty $entry 'path'))
    $hash = ([string](Get-RequiredProperty $entry 'sha256')).ToUpperInvariant()
    if ($hash -cnotmatch '^[A-F0-9]{64}$') {
        throw "The supported-runtime manifest contains an invalid SHA-256 for '$relative'."
    }
    if ($null -ne $previousPath -and [StringComparer]::Ordinal.Compare($previousPath, $relative) -ge 0) {
        throw 'The supported-runtime manifest file paths must be unique and sorted with ordinal ordering.'
    }
    if ($expectedFiles.ContainsKey($relative)) {
        throw "The supported-runtime manifest contains a case-insensitive duplicate path: '$relative'."
    }
    $expectedFiles.Add($relative, $hash)
    $previousPath = $relative
}

$actualEntries = @(Get-TreeEntries $root)
$actualFiles = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $actualEntries) {
    if ($actualFiles.ContainsKey($entry.Path)) { throw "The selected Grok Bot tree contains a duplicate path: '$($entry.Path)'." }
    $actualFiles.Add($entry.Path, $entry.FullName)
}

$missing = @($expectedFiles.Keys | Where-Object { -not $actualFiles.ContainsKey($_) } | Sort-Object)
$extra = @($actualFiles.Keys | Where-Object { -not $expectedFiles.ContainsKey($_) } | Sort-Object)
if ($missing.Count -ne 0) {
    throw "The selected Grok Bot tree is missing manifest file(s): $([string]::Join(', ', $missing))."
}
if ($extra.Count -ne 0) {
    throw "The selected Grok Bot tree contains unexpected file(s): $([string]::Join(', ', $extra))."
}

foreach ($relative in $expectedFiles.Keys) {
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $actualFiles[$relative]).Hash.ToUpperInvariant()
    if ($actualHash -cne $expectedFiles[$relative]) {
        throw "The selected Grok Bot tree contains a hash mismatch: '$relative'."
    }
}

$vendorExe = $actualFiles['Grok Bot.exe']
if ([string]::IsNullOrWhiteSpace($vendorExe)) { throw 'The supported-runtime manifest does not include Grok Bot.exe.' }
$signature = Get-AuthenticodeSignature -LiteralPath $vendorExe
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) {
    throw "Grok Bot.exe does not have a valid Authenticode signature (status: $($signature.Status))."
}
$actualSignerSubject = [string]$signature.SignerCertificate.Subject
$actualSignerThumbprint = ([string]$signature.SignerCertificate.Thumbprint).ToUpperInvariant()
if ($actualSignerSubject -cne $expectedSignerSubject -or $actualSignerThumbprint -cne $expectedSignerThumbprint) {
    throw 'Grok Bot.exe is validly signed, but not by the reviewed pinned signer identity.'
}

[pscustomobject]@{
    ok = $true
    product = $expectedProduct
    version = $expectedVersion
    fileCount = $expectedFiles.Count
    signerThumbprint = $actualSignerThumbprint
}
