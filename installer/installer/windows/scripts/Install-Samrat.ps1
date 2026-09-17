#Requires -Version 5.1
. "$PSScriptRoot\Common.ps1"
. "$PSScriptRoot\New-SamratEnvironment.ps1"

Write-Host "Samrat Case Review - local server installation" -ForegroundColor Cyan
Write-Host "All case data and files will remain on this Windows computer."
Write-Host "Document content is sent to OpenRouter/Gemini for AI analysis." -ForegroundColor Yellow

$docker = Assert-DockerReady
$root = Get-SamratRoot
$supabaseRoot = Get-SupabaseRoot
$environmentPath = Join-Path $supabaseRoot ".env"

if (-not (Test-Path $environmentPath)) {
    $secureApiKey = Read-Host "Paste the OpenRouter API key" -AsSecureString
    $apiKey = ConvertFrom-SecureValue $secureApiKey
    try {
        New-SamratEnvironment -OpenRouterApiKey $apiKey | Out-Null
    } finally {
        $apiKey = $null
    }
    Write-Host "Generated unique local database and authentication secrets." -ForegroundColor Green
} else {
    Write-Host "Existing configuration found; keeping its database and keys."
}

$imageArchive = Join-Path $root "payload\images\samrat-app-images.tar"
$imageChecksum = "$imageArchive.sha256"
Assert-SamratImageArchive -ArchivePath $imageArchive -ChecksumPath $imageChecksum

Write-Host "Loading Samrat application images..."
& $docker load --input $imageArchive
if ($LASTEXITCODE -ne 0) { throw "Could not load the Samrat application images." }

Write-Host "Downloading the pinned Supabase services. The first installation can take several minutes..."
Invoke-SamratCompose -Arguments @(
    "pull", "db", "auth", "rest", "storage", "imgproxy", "meta", "studio", "api-gw", "samrat-migrate"
)

Write-Host "Starting the local database, authentication, storage, app, and analysis worker..."
Invoke-SamratCompose -Arguments @(
    "up", "-d",
    "db", "auth", "rest", "imgproxy", "storage", "meta", "studio", "api-gw",
    "samrat-migrate", "samrat-web", "samrat-worker"
)

Wait-SamratUrl -Url "http://127.0.0.1:8000/auth/v1/health" -TimeoutSeconds 300
Wait-SamratUrl -Url "http://127.0.0.1:8888/api/health" -TimeoutSeconds 300
Set-SamratFirewallRules

$environment = Read-DotEnv $environmentPath
$adminEmail = Read-Host "Email address for the first Samrat administrator"
$adminPasswordSecure = Read-Host "Password for the first Samrat administrator (at least 10 characters)" -AsSecureString
$adminPassword = ConvertFrom-SecureValue $adminPasswordSecure
try {
    if ([string]::IsNullOrWhiteSpace($adminEmail)) { throw "Administrator email is required." }
    if ($adminPassword.Length -lt 10) { throw "Administrator password must have at least 10 characters." }

    $headers = @{
        apikey = $environment["SERVICE_ROLE_KEY"]
        Authorization = "Bearer $($environment["SERVICE_ROLE_KEY"])"
        "Content-Type" = "application/json"
    }
    $body = @{
        email = $adminEmail.Trim()
        password = $adminPassword
        email_confirm = $true
        app_metadata = @{ role = "admin" }
    } | ConvertTo-Json -Depth 4 -Compress

    try {
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/auth/v1/admin/users" -Headers $headers -Body $body | Out-Null
        Write-Host "Created the first administrator." -ForegroundColor Green
    } catch {
        if ($_.Exception.Message -match "already|registered|exists|422") {
            Write-Host "That administrator already exists; keeping the existing account." -ForegroundColor Yellow
        } else {
            throw
        }
    }
} finally {
    $adminPassword = $null
}

Write-Host ""
Write-Host "Samrat Case Review is ready at http://localhost:8888" -ForegroundColor Green
Write-Host "Other office computers can use http://<this-PC-name>:8888 while on the same private network."
Start-Process "http://localhost:8888"
