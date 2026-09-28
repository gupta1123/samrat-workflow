$ErrorActionPreference = "Stop"
. "$PSScriptRoot\..\scripts\Common.ps1"

$script:capturedHeaders = $null
$script:requestCount = 0
$script:failFirstRequest = $false

function global:Invoke-WebRequest {
    param(
        [switch] $UseBasicParsing,
        [string] $Uri,
        [hashtable] $Headers,
        [int] $TimeoutSec
    )
    $script:requestCount += 1
    $script:capturedHeaders = $Headers
    if ($script:failFirstRequest -and $script:requestCount -eq 1) {
        throw "Simulated service startup"
    }
    return [pscustomobject]@{ StatusCode = 200 }
}

function global:Start-Sleep { param([int] $Seconds) }

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw $Message }
}

$testKey = "test-anon-key-not-a-real-secret"
Wait-SamratUrl `
    -Url "http://127.0.0.1:8000/auth/v1/health" `
    -Headers @{ apikey = $testKey } `
    -TimeoutSeconds 2
Assert-True ($script:capturedHeaders["apikey"] -ceq $testKey) "Health-check API key was not forwarded."
Write-Host "PASS Auth health check forwards its API key"

$script:capturedHeaders = $null
$script:requestCount = 0
Wait-SamratUrl -Url "http://127.0.0.1:8888/api/health" -TimeoutSeconds 2
Assert-True ($script:capturedHeaders.Count -eq 0) "Public app health check unexpectedly received authentication headers."
Write-Host "PASS Public app health check remains unauthenticated"

$script:requestCount = 0
$script:failFirstRequest = $true
Wait-SamratUrl `
    -Url "http://127.0.0.1:8000/auth/v1/health" `
    -Headers @{ apikey = $testKey } `
    -TimeoutSeconds 2
Assert-True ($script:requestCount -eq 2) "Health check did not retry a service that was still starting."
Write-Host "PASS Health check retries while the service starts"

Write-Host "3 passed; 0 failed."
