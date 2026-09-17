#Requires -Version 5.1
. "$PSScriptRoot\Common.ps1"

$root = Get-SamratRoot
$archive = Join-Path $root "payload\images\samrat-app-images.tar"
$checksumFile = "$archive.sha256"
$versionFile = Join-Path $root "payload\version.txt"
if (-not (Test-Path $versionFile)) {
    throw "The update payload is incomplete."
}
Assert-SamratImageArchive -ArchivePath $archive -ChecksumPath $checksumFile

$docker = Assert-DockerReady
$version = ([IO.File]::ReadAllText($versionFile)).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "The update version is invalid."
}

Write-Host "Loading Samrat $version..." -ForegroundColor Cyan
& $docker load --input $archive
if ($LASTEXITCODE -ne 0) { throw "Could not load the update images." }

$environmentPath = Join-Path (Get-SupabaseRoot) ".env"
$content = [IO.File]::ReadAllText($environmentPath)
$pattern = '(?m)^SAMRAT_VERSION=.*$'
if ([Regex]::IsMatch($content, $pattern)) {
    $content = [Regex]::Replace($content, $pattern, "SAMRAT_VERSION=$version")
} else {
    $content = $content.TrimEnd() + [Environment]::NewLine + "SAMRAT_VERSION=$version" + [Environment]::NewLine
}
[IO.File]::WriteAllText($environmentPath, $content, (New-Object Text.UTF8Encoding($false)))

Invoke-SamratCompose -Arguments @(
    "up", "-d", "--force-recreate",
    "samrat-migrate", "samrat-web", "samrat-worker"
)
Wait-SamratUrl -Url "http://127.0.0.1:8888/api/health" -TimeoutSeconds 300
Write-Host "Samrat was updated to $version." -ForegroundColor Green
