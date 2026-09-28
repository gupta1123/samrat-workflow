#Requires -Version 5.1
. "$PSScriptRoot\Common.ps1"

Write-Host "Starting Samrat Case Review..." -ForegroundColor Cyan
Invoke-SamratCompose -Arguments @(
    "up", "-d",
    "db", "auth", "rest", "imgproxy", "storage", "meta", "studio", "api-gw",
    "samrat-migrate", "samrat-web", "samrat-worker"
)
Wait-SamratUrl -Url "http://127.0.0.1:8888/api/health" -TimeoutSeconds 300
Write-Host "Samrat is ready at http://localhost:8888" -ForegroundColor Green
Start-Process "http://localhost:8888"
