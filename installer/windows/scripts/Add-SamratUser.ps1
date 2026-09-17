#Requires -Version 5.1
. "$PSScriptRoot\Common.ps1"

Write-Host "Add a Samrat Case Review user" -ForegroundColor Cyan
$environmentPath = Join-Path (Get-SupabaseRoot) ".env"
if (-not (Test-Path $environmentPath)) {
    throw "Samrat is not installed yet. Run Install Samrat first."
}

$environment = Read-DotEnv $environmentPath
$anonKey = $environment["ANON_KEY"]
if ([string]::IsNullOrWhiteSpace($anonKey)) {
    throw "The local Supabase API key is missing from the existing configuration."
}
Wait-SamratUrl `
    -Url "http://127.0.0.1:8000/auth/v1/health" `
    -TimeoutSeconds 60 `
    -Headers @{ apikey = $anonKey }

$email = (Read-Host "User email address").Trim()
$passwordSecure = Read-Host "Temporary password (at least 10 characters)" -AsSecureString
$password = ConvertFrom-SecureValue $passwordSecure
try {
    if ([string]::IsNullOrWhiteSpace($email) -or $email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        throw "Enter a valid email address."
    }
    if ($password.Length -lt 10) {
        throw "The password must have at least 10 characters."
    }

    $headers = @{
        apikey = $environment["SERVICE_ROLE_KEY"]
        Authorization = "Bearer $($environment["SERVICE_ROLE_KEY"])"
        "Content-Type" = "application/json"
    }
    $body = @{
        email = $email
        password = $password
        email_confirm = $true
    } | ConvertTo-Json -Compress

    Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:8000/auth/v1/admin/users" `
        -Headers $headers `
        -Body $body | Out-Null
    Write-Host "User created. They can now sign in at http://localhost:8888" -ForegroundColor Green
} catch {
    if ($_.Exception.Message -match "already|registered|exists|422") {
        throw "A user with this email already exists."
    }
    throw
} finally {
    $password = $null
}

Read-Host "Press Enter to close"
