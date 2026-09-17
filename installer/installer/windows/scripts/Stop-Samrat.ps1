#Requires -Version 5.1
. "$PSScriptRoot\Common.ps1"

Write-Host "Stopping Samrat Case Review..." -ForegroundColor Cyan
Invoke-SamratCompose -Arguments @("stop")
Write-Host "Samrat is stopped. Local data is unchanged." -ForegroundColor Green
