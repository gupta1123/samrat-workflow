#Requires -Version 5.1
param([string] $Version = "1.0.0")

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$archive = Join-Path $PSScriptRoot "payload\images\samrat-app-images.tar"
$checksumFile = "$archive.sha256"
$versionFile = Join-Path $PSScriptRoot "payload\version.txt"

Push-Location $projectRoot
try {
    docker buildx build --platform linux/amd64 --target web -t "samrat-workflow-web:$Version" --load .
    if ($LASTEXITCODE -ne 0) { throw "Web image build failed." }
    docker buildx build --platform linux/amd64 --target worker -t "samrat-workflow-worker:$Version" --load .
    if ($LASTEXITCODE -ne 0) { throw "Worker image build failed." }
    docker save --output $archive "samrat-workflow-web:$Version" "samrat-workflow-worker:$Version"
    if ($LASTEXITCODE -ne 0) { throw "Could not create the image archive." }
    $checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(
        $checksumFile,
        "$checksum  $([IO.Path]::GetFileName($archive))`n",
        (New-Object Text.UTF8Encoding($false))
    )
    [IO.File]::WriteAllText($versionFile, "$Version`n", (New-Object Text.UTF8Encoding($false)))
} finally {
    Pop-Location
}

Write-Host "Created Windows Linux/AMD64 image payload: $archive" -ForegroundColor Green
