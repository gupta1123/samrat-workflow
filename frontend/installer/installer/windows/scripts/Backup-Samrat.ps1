#Requires -Version 5.1
param(
    [string] $Destination = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Samrat Backups")
)

. "$PSScriptRoot\Common.ps1"

$docker = Assert-DockerReady
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $Destination "samrat-$stamp"
$supabaseRoot = Get-SupabaseRoot
$storageRoot = Join-Path $supabaseRoot "volumes\storage"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

Write-Host "Pausing case access while a consistent backup is created..." -ForegroundColor Cyan
Invoke-SamratCompose -Arguments @(
    "stop", "samrat-worker", "samrat-web", "api-gw", "studio", "meta", "storage", "rest", "auth", "imgproxy"
)

try {
    Invoke-SamratCompose -Arguments @("up", "-d", "db")

    Write-Host "Backing up PostgreSQL..."
    & $docker exec supabase-db pg_dump -U postgres -d postgres --format=custom --file=/tmp/samrat.backup
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL backup failed." }
    & $docker cp "supabase-db:/tmp/samrat.backup" (Join-Path $backupRoot "database.backup")
    if ($LASTEXITCODE -ne 0) { throw "Could not copy the PostgreSQL backup." }
    & $docker exec supabase-db rm -f /tmp/samrat.backup

    Write-Host "Backing up uploaded documents..."
    & $docker run --rm `
        --mount "type=bind,source=$storageRoot,target=/data,readonly" `
        --mount "type=bind,source=$backupRoot,target=/backup" `
        postgres:17.6-alpine tar -czf /backup/storage.tar.gz -C /data .
    if ($LASTEXITCODE -ne 0) { throw "Document storage backup failed." }

    $manifest = [ordered]@{
        product = "Samrat Case Review"
        createdAt = [DateTimeOffset]::Now.ToString("o")
        databaseFormat = "PostgreSQL custom"
        includes = @("database", "uploaded documents")
    } | ConvertTo-Json -Depth 3
    [IO.File]::WriteAllText(
        (Join-Path $backupRoot "manifest.json"),
        $manifest,
        (New-Object Text.UTF8Encoding($false))
    )
} finally {
    Write-Host "Restarting Samrat..."
    Invoke-SamratCompose -Arguments @(
        "up", "-d",
        "db", "auth", "rest", "imgproxy", "storage", "meta", "studio", "api-gw",
        "samrat-migrate", "samrat-web", "samrat-worker"
    )
}

Write-Host "Backup complete: $backupRoot" -ForegroundColor Green
Start-Process explorer.exe $backupRoot
