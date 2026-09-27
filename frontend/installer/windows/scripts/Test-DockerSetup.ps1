#Requires -Version 5.1
param([string] $OutputPath)

$ErrorActionPreference = "Stop"
try {
    . "$PSScriptRoot\DockerEnvironment.ps1"
    $docker = Assert-DockerReady -NoStart
    $message = "Docker is ready: Linux engine and Docker Compose are available. CLI: $docker"
    $exitCode = 0
} catch {
    $message = $_.Exception.Message
    $exitCode = 1
}

Write-Host $message
if ($OutputPath) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($OutputPath, $message, $encoding)
}
exit $exitCode
