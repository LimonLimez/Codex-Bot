param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$DiagnosticPath
)

$ErrorActionPreference = 'Stop'
trap {
    $diagnosticMessage = [string]$_.Exception.Message
    if (-not [string]::IsNullOrWhiteSpace($DiagnosticPath)) {
        [IO.File]::WriteAllText(
            [IO.Path]::GetFullPath($DiagnosticPath),
            $diagnosticMessage,
            [Text.UTF8Encoding]::new($false)
        )
    } else {
        [Console]::Error.WriteLine($diagnosticMessage)
    }
    exit 1
}
$expectedLength = 125825552L
$expectedSha256 = '464079A15EF5FA8B61CCEA8FFFCC78F63CFCF6DF65FB0AD5E725D8B95F7E437E'
$expectedVersion = '0.18.0'
$expectedProduct = 'Grok Bot'
$expectedCompany = 'SpaceXAI'
$expectedSignerSubject = 'CN="Anysphere, Inc.", O="Anysphere, Inc.", L=San Francisco, S=California, C=US'
$expectedSignerThumbprint = '67E878CBE262D364A6D059B77DAC002E2C064F0E'
$expectedSignerIssuer = 'CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US'

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "The pinned Grok Bot installer is missing: $InstallerPath"
}
$installer = Get-Item -LiteralPath $InstallerPath -Force
if (($installer.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The pinned Grok Bot installer cannot be a reparse point.'
}
if ([long]$installer.Length -ne $expectedLength) {
    throw "The pinned Grok Bot installer length is wrong: expected $expectedLength bytes, got $($installer.Length)."
}
$hashStream = [IO.File]::Open(
    $installer.FullName,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
)
try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $actualHash = ([BitConverter]::ToString($sha256.ComputeHash($hashStream))).Replace('-', '')
    } finally {
        $sha256.Dispose()
    }
} finally {
    $hashStream.Dispose()
}
if ($actualHash -cne $expectedSha256) {
    throw "The pinned Grok Bot installer SHA-256 is wrong: expected $expectedSha256, got $actualHash."
}

$version = $installer.VersionInfo
if ([string]$version.FileVersion -cne $expectedVersion -or
    [string]$version.ProductVersion -cne $expectedVersion -or
    [string]$version.ProductName -cne $expectedProduct -or
    [string]$version.CompanyName -cne $expectedCompany) {
    throw 'The pinned Grok Bot installer version metadata does not match the reviewed 0.18.0 user installer.'
}

$authenticodeCommand = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue
if ($null -ne $authenticodeCommand) {
    $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
} else {
    $signatureHelper = [System.Management.Automation.PSObject].Assembly.GetType(
        'System.Management.Automation.SignatureHelper',
        $true
    )
    $getSignature = $signatureHelper.GetMethods(
        [Reflection.BindingFlags]'Static,NonPublic'
    ) | Where-Object { $_.Name -ceq 'GetSignature' } | Select-Object -First 1
    if ($null -eq $getSignature) {
        throw 'The built-in Windows Authenticode verifier is unavailable.'
    }
    $signature = $getSignature.Invoke($null, @($installer.FullName, $null))
}
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) {
    throw "The pinned Grok Bot installer does not have a valid Authenticode signature (status: $($signature.Status))."
}
$certificate = $signature.SignerCertificate
$actualSubject = [string]$certificate.Subject
$actualThumbprint = ([string]$certificate.Thumbprint).ToUpperInvariant()
$actualIssuer = [string]$certificate.Issuer
if ($actualSubject -cne $expectedSignerSubject -or
    $actualThumbprint -cne $expectedSignerThumbprint -or
    $actualIssuer -cne $expectedSignerIssuer) {
    throw 'The pinned Grok Bot installer is validly signed, but not by the exact reviewed artifact signer.'
}

if (-not [string]::IsNullOrWhiteSpace($DiagnosticPath)) {
    [IO.File]::WriteAllText(
        [IO.Path]::GetFullPath($DiagnosticPath),
        'ok',
        [Text.UTF8Encoding]::new($false)
    )
}

[pscustomobject]@{
    ok = $true
    product = $expectedProduct
    version = $expectedVersion
    length = $expectedLength
    sha256 = $actualHash
    signerSubject = $actualSubject
    signerThumbprint = $actualThumbprint
}
