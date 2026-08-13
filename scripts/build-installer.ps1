param(
    [string]$InnoCompiler = ''
)

$ErrorActionPreference = 'Stop'
$cliProxyVersion = '7.2.130'
$cliProxyZipSha256 = 'C1D9F07AF4698C4F63A5F6A866BECD8279B7AF849F6E17D7EF4A7D049B54E3B7'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = Join-Path $projectRoot 'build'
$vendorRoot = Join-Path $buildRoot 'vendor\cliproxyapi'
$artifactsRoot = Join-Path $projectRoot 'artifacts'
$package = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$packageVersion = [string]$package.version
if ($packageVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "package.json contains an invalid release version: $packageVersion"
}
$installerName = "CodexBot-Setup-$packageVersion.exe"
$installerPath = Join-Path $artifactsRoot $installerName
New-Item -ItemType Directory -Force -Path $vendorRoot, $artifactsRoot | Out-Null

Push-Location $projectRoot
try {
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

    $headers = @{ 'User-Agent' = 'Codex-Bot-Release-Builder' }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/tags/v$cliProxyVersion" -Headers $headers
    if ([string]$release.tag_name -ne "v$cliProxyVersion") { throw 'CLIProxyAPI release tag did not match the pinned version.' }
    $assetName = "CLIProxyAPI_${cliProxyVersion}_windows_amd64.zip"
    $asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
    $checksumsAsset = $release.assets | Where-Object { $_.name -eq 'checksums.txt' } | Select-Object -First 1
    if (-not $asset -or -not $checksumsAsset) { throw 'The latest CLIProxyAPI release does not contain the expected Windows asset/checksums.' }

    $zipPath = Join-Path $buildRoot $asset.name
    $checksumsPath = Join-Path $buildRoot 'checksums.txt'
    Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $zipPath
    Invoke-WebRequest -Uri $checksumsAsset.browser_download_url -Headers $headers -OutFile $checksumsPath
    $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match ([regex]::Escape($asset.name) + '$') } | Select-Object -First 1
    if (-not $checksumLine) { throw "No checksum was published for $($asset.name)." }
    $publishedHash = ($checksumLine -split '\s+')[0].ToUpperInvariant()
    $expectedHash = $cliProxyZipSha256.ToUpperInvariant()
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToUpperInvariant()
    if ($publishedHash -ne $expectedHash) { throw "The published CLIProxyAPI checksum does not match the reviewed pinned checksum." }
    if ($actualHash -ne $expectedHash) { throw "CLIProxyAPI checksum mismatch: expected $expectedHash, got $actualHash" }

    $extractRoot = Join-Path $buildRoot ('cliproxyapi-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $extractRoot | Out-Null
    try {
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
        $proxy = Get-ChildItem -LiteralPath $extractRoot -Recurse -File | Where-Object { $_.Name -match '^(cli-proxy-api|CLIProxyAPI)\.exe$' } | Select-Object -First 1
        if (-not $proxy) { throw 'CLIProxyAPI executable was not found in the verified release archive.' }
        Copy-Item -LiteralPath $proxy.FullName -Destination (Join-Path $vendorRoot 'cli-proxy-api.exe') -Force
    } finally {
        $resolvedExtract = [IO.Path]::GetFullPath($extractRoot)
        if ($resolvedExtract.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedExtract -Recurse -Force
        }
    }
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v$cliProxyVersion/LICENSE" -Headers $headers -OutFile (Join-Path $vendorRoot 'LICENSE')

    if (-not $InnoCompiler) {
        $candidates = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
            (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
        $InnoCompiler = $candidates | Select-Object -First 1
    }
    if (-not $InnoCompiler -or -not (Test-Path -LiteralPath $InnoCompiler)) {
        throw 'Inno Setup 6 was not found. Install JRSoftware.InnoSetup or pass -InnoCompiler.'
    }
    & $InnoCompiler (Join-Path $projectRoot 'installer\CodexBot.iss')
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
        throw "Inno Setup did not produce the expected current-version installer: $installerName"
    }
    $installer = Get-Item -LiteralPath $installerPath
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName).Hash.ToLowerInvariant()
    $hashFile = "$installerPath.sha256"
    $expectedSidecar = "$hash  $installerName"
    $expectedSidecar | Set-Content -LiteralPath $hashFile -Encoding Ascii
    $actualSidecar = (Get-Content -Raw -LiteralPath $hashFile).Trim()
    if ($actualSidecar -cne $expectedSidecar) {
        throw "The checksum sidecar could not be verified for $installerName."
    }
    [pscustomobject]@{ Name = $installer.Name; Length = $installer.Length; SHA256 = $hash; HashFile = $hashFile }
} finally {
    Pop-Location
}
