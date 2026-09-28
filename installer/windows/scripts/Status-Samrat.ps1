#Requires -Version 5.1
. "$PSScriptRoot\Common.ps1"

Invoke-SamratCompose -Arguments @("ps", "--all")
Write-Host ""
Write-Host "Recent analysis worker activity:" -ForegroundColor Cyan
Invoke-SamratCompose -Arguments @("logs", "--tail", "40", "samrat-worker")
