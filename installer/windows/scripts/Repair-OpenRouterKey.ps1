#Requires -Version 5.1

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
$isAdministrator = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
    Write-Host "Administrator access is required to update the protected Samrat configuration." -ForegroundColor Yellow
    $arguments = "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments
    exit
}

. "$PSScriptRoot\Common.ps1"
. "$PSScriptRoot\New-SamratEnvironment.ps1"

Write-Host "Samrat Case Review - repair OpenRouter key" -ForegroundColor Cyan
Write-Host "This changes only the AI API key. Cases, users, and uploaded files are preserved."

$docker = Assert-DockerReady
$environmentPath = Join-Path (Get-SupabaseRoot) ".env"
if (-not (Test-Path -LiteralPath $environmentPath)) {
    throw "Samrat is not configured yet. Run Install Samrat first."
}

$secureApiKey = Read-Host "Paste the OpenRouter API key (copy only the key value)" -AsSecureString
$apiKey = ConvertFrom-SecureValue $secureApiKey
try {
    Set-SamratOpenRouterApiKey -EnvironmentPath $environmentPath -OpenRouterApiKey $apiKey | Out-Null
} finally {
    $apiKey = $null
}

Write-Host "Restarting the Samrat application with the repaired key..."
Invoke-SamratCompose -Arguments @("up", "-d", "--force-recreate", "samrat-web", "samrat-worker")
Assert-OpenRouterKeyReady -DockerPath $docker

Write-Host "The OpenRouter key is repaired and Samrat is ready. Retry the failed case once." -ForegroundColor Green
