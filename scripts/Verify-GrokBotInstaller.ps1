param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
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
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName).Hash.ToUpperInvariant()
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

$signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
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

[pscustomobject]@{
    ok = $true
    product = $expectedProduct
    version = $expectedVersion
    length = $expectedLength
    sha256 = $actualHash
    signerSubject = $actualSubject
    signerThumbprint = $actualThumbprint
}
