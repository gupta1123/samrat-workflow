#Requires -Version 5.1
param(
    [string] $Version = "1.0.0",
    [switch] $SkipImages
)

$ErrorActionPreference = "Stop"
if (-not $SkipImages) {
    & (Join-Path $PSScriptRoot "Build-AppImages.ps1") -Version $Version
    if ($LASTEXITCODE -ne 0) { throw "Application image packaging failed." }
}

$archive = Join-Path $PSScriptRoot "payload\images\samrat-app-images.tar"
$checksumFile = "$archive.sha256"
$versionFile = Join-Path $PSScriptRoot "payload\version.txt"
if (-not (Test-Path $archive) -or -not (Test-Path $checksumFile) -or -not (Test-Path $versionFile)) {
    throw "Build the complete application image payload first."
}
$payloadVersion = ([IO.File]::ReadAllText($versionFile)).Trim()
if ($payloadVersion -cne $Version) {
    throw "The image payload is version $payloadVersion but the requested installer version is $Version. Rebuild the images or use the matching version."
}
$expectedChecksum = (([IO.File]::ReadAllText($checksumFile)).Trim() -split '\s+')[0].ToLowerInvariant()
$actualChecksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
if ($expectedChecksum -notmatch '^[0-9a-f]{64}$' -or $actualChecksum -cne $expectedChecksum) {
    throw "The image payload checksum is missing or does not match."
}

$compilerCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
)
$compiler = $compilerCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $compiler) {
    throw "Inno Setup 6 is required to compile the final setup EXE. Install it from https://jrsoftware.org/isdl.php"
}

& $compiler "/DAppVersion=$Version" (Join-Path $PSScriptRoot "SamratCaseReview.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed." }
$output = Join-Path $PSScriptRoot "output\Samrat-Case-Review-Setup-$Version-Installer5.exe"
if (-not (Test-Path -LiteralPath $output)) { throw "The compiler did not create the expected Installer 5 EXE: $output" }
Write-Host "Windows installer created: $output" -ForegroundColor Green
