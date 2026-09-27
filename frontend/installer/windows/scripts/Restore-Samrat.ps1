#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)]
    [string] $BackupFolder
)

. "$PSScriptRoot\Common.ps1"

$databaseBackup = Join-Path $BackupFolder "database.backup"
$storageBackup = Join-Path $BackupFolder "storage.tar.gz"
if (-not (Test-Path $databaseBackup) -or -not (Test-Path $storageBackup)) {
    throw "The selected folder is not a complete Samrat backup."
}

Write-Host "This will replace every current Samrat case and uploaded document." -ForegroundColor Red
$confirmation = Read-Host "Type RESTORE to continue"
if ($confirmation -cne "RESTORE") {
    Write-Host "Restore cancelled."
    exit 0
}

$docker = Assert-DockerReady
$supabaseRoot = Get-SupabaseRoot
$storageRoot = Join-Path $supabaseRoot "volumes\storage"

Invoke-SamratCompose -Arguments @(
    "stop", "samrat-worker", "samrat-web", "api-gw", "studio", "meta", "storage", "rest", "auth", "imgproxy"
)
Invoke-SamratCompose -Arguments @("up", "-d", "db")

Write-Host "Restoring PostgreSQL..." -ForegroundColor Cyan
& $docker cp $databaseBackup "supabase-db:/tmp/samrat.backup"
if ($LASTEXITCODE -ne 0) { throw "Could not copy the database backup." }
& $docker exec supabase-db pg_restore -U postgres -d postgres --clean --if-exists --no-owner --exit-on-error /tmp/samrat.backup
if ($LASTEXITCODE -ne 0) { throw "Database restore failed. The services remain stopped so the error can be inspected safely." }
& $docker exec supabase-db rm -f /tmp/samrat.backup

Write-Host "Restoring uploaded documents..."
& $docker run --rm `
    --mount "type=bind,source=$storageRoot,target=/data" `
    --mount "type=bind,source=$BackupFolder,target=/backup,readonly" `
    postgres:17.6-alpine sh -c "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf /backup/storage.tar.gz -C /data"
if ($LASTEXITCODE -ne 0) { throw "Document storage restore failed." }

Write-Host "Restarting Samrat..."
Invoke-SamratCompose -Arguments @(
    "up", "-d",
    "db", "auth", "rest", "imgproxy", "storage", "meta", "studio", "api-gw",
    "samrat-migrate", "samrat-web", "samrat-worker"
)
Wait-SamratUrl -Url "http://127.0.0.1:8888/api/health" -TimeoutSeconds 300
Write-Host "Restore complete." -ForegroundColor Green
