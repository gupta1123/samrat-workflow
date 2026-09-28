#Requires -Version 5.1
param([switch] $RemoveData)

. "$PSScriptRoot\Common.ps1"

Write-Host "Stopping and removing Samrat containers..." -ForegroundColor Cyan
try {
    if ($RemoveData) {
        Write-Host "This permanently deletes all cases, users, uploaded documents, and local secrets." -ForegroundColor Red
        $confirmation = Read-Host "Type DELETE ALL SAMRAT DATA to continue"
        if ($confirmation -cne "DELETE ALL SAMRAT DATA") {
            Write-Host "Data deletion cancelled. Containers will be removed but data will be kept."
            Invoke-SamratCompose -Arguments @("down", "--remove-orphans")
        } else {
            Invoke-SamratCompose -Arguments @("down", "--volumes", "--remove-orphans")
            Remove-Item -LiteralPath (Join-Path (Get-SupabaseRoot) "volumes\db\data") -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath (Join-Path (Get-SupabaseRoot) "volumes\storage") -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath (Join-Path (Get-SupabaseRoot) ".env") -Force -ErrorAction SilentlyContinue
        }
    } else {
        Invoke-SamratCompose -Arguments @("down", "--remove-orphans")
    }
} finally {
    Remove-NetFirewallRule -DisplayName "Samrat Case Review - Private Network" -ErrorAction SilentlyContinue
}

Write-Host "Samrat containers were removed. Local data was preserved unless full deletion was explicitly selected." -ForegroundColor Green
