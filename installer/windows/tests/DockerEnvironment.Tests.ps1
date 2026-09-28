#Requires -Version 5.1
# Isolated regression checks: no Docker install, settings, or data are modified.
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\..\scripts\DockerEnvironment.ps1"

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("samrat-docker-tests-" + [guid]::NewGuid())
$environmentNames = @("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA")
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
$script:passed = 0
$script:failed = 0

function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'." }
}
function Assert-Throws([scriptblock] $Action, [string] $Pattern) {
    $message = $null
    try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
    if (-not $message -or $message -notmatch $Pattern) { throw "Expected error matching '$Pattern', got '$message'." }
}
function Test-Scenario([string] $Name, [scriptblock] $Action) {
    try { & $Action; $script:passed++; Write-Host "PASS $Name" }
    catch { $script:failed++; Write-Host "FAIL ${Name}: $($_.Exception.Message)" }
}
function Reset-Scenario {
    $root = Join-Path $testRoot ([guid]::NewGuid().ToString())
    $env:ProgramFiles = Join-Path $root "Program Files"
    $env:ProgramW6432 = $env:ProgramFiles
    ${env:ProgramFiles(x86)} = Join-Path $root "Program Files (x86)"
    $env:LOCALAPPDATA = Join-Path $root "Local App Data"
    $script:registry = @{}
    $script:running = @()
    $script:pathCommand = $null
    $script:startCalls = 0
    $script:probeMode = "linux"
    $script:probeCalls = @()
}
function New-FakeDesktop([string] $Root) {
    $bin = Join-Path $Root "resources\bin"
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    New-Item -ItemType File -Path (Join-Path $Root "Docker Desktop.exe") -Force | Out-Null
    $cli = Join-Path $bin "docker.exe"
    New-Item -ItemType File -Path $cli -Force | Out-Null
    return $cli
}

# Model Windows machine/user discovery without touching the real registry.
function Get-ItemProperty($LiteralPath, $ErrorAction) { return $script:registry[$LiteralPath] }
function Get-Process($Name, $ErrorAction) { return $script:running }
function Get-Command($Name, $CommandType, $ErrorAction) {
    if ($script:pathCommand) { return [pscustomobject] @{ Source = $script:pathCommand } }
}
function Start-Process($FilePath) { $script:startCalls++; throw "Unexpected attempt to start Docker during a read-only check." }

try {
    Test-Scenario "Finds all-users Docker with an unchanged PATH" {
        Reset-Scenario
        $expected = New-FakeDesktop (Join-Path $env:ProgramFiles "Docker\Docker")
        Assert-Equal (Get-DockerCommand) $expected
    }
    Test-Scenario "Finds per-user Docker with spaces in its path" {
        Reset-Scenario
        $expected = New-FakeDesktop (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop")
        Assert-Equal (Get-DockerCommand) $expected
    }
    Test-Scenario "Finds 64-bit Docker from a 32-bit process environment" {
        Reset-Scenario
        $expected = New-FakeDesktop (Join-Path $env:ProgramW6432 "Docker\Docker")
        $env:ProgramFiles = ${env:ProgramFiles(x86)}
        Assert-Equal (Get-DockerCommand) $expected
    }
    Test-Scenario "Finds a registered custom install and ignores incomplete registry entries" {
        Reset-Scenario
        $custom = Join-Path $testRoot "Custom Docker"
        $expected = New-FakeDesktop $custom
        $script:registry["HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop"] = [pscustomobject] @{ InstallLocation = $custom }
        $script:registry["HKLM:\SOFTWARE\Docker Inc.\Docker Desktop"] = [pscustomobject] @{ DisplayName = "Docker" }
        Assert-Equal (Get-DockerCommand) $expected
    }
    Test-Scenario "Finds a running Docker app in a custom location" {
        Reset-Scenario
        $custom = Join-Path $testRoot "Running Docker"
        $expected = New-FakeDesktop $custom
        $script:running = @([pscustomobject] @{ Path = (Join-Path $custom "Docker Desktop.exe") })
        Assert-Equal (Get-DockerCommand) $expected
    }
    Test-Scenario "Falls back to an application on PATH" {
        Reset-Scenario
        $script:pathCommand = Join-Path $testRoot "path\docker.exe"
        Assert-Equal (Get-DockerCommand) $script:pathCommand
    }
    Test-Scenario "Missing Docker produces an account-aware error" {
        Reset-Scenario
        Assert-Throws { Get-DockerCommand } "same Windows account"
    }

    $pwsh = Join-Path $PSHOME "pwsh"
    if (-not (Test-Path -LiteralPath $pwsh)) { $pwsh = Join-Path $PSHOME "powershell.exe" }
    if (-not (Test-Path -LiteralPath $pwsh)) { $pwsh = Join-Path $PSHOME "pwsh.exe" }
    Test-Scenario "Native probe captures output and exit status" {
        $result = Invoke-SamratDockerProbe -DockerPath $pwsh -Arguments '-NoLogo -NoProfile -Command "Write-Output linux"'
        Assert-Equal $result.Success $true
        Assert-Equal $result.Output "linux"
    }
    Test-Scenario "Native probe reports executable launch failure" {
        $result = Invoke-SamratDockerProbe -DockerPath (Join-Path $testRoot "missing.exe") -Arguments 'info'
        Assert-Equal $result.Success $false
    }
    Test-Scenario "Native probe times out instead of hanging setup" {
        $result = Invoke-SamratDockerProbe -DockerPath $pwsh -Arguments '-NoLogo -NoProfile -Command "Start-Sleep -Seconds 10"' -TimeoutSeconds 1
        Assert-Equal $result.Success $false
        Assert-Equal $result.Error "Docker did not respond within 1 seconds."
    }

    # Deterministically exercise readiness states; do not contact a real daemon.
    function Invoke-SamratDockerProbe($DockerPath, $Arguments) {
        $script:probeCalls += $Arguments
        if ($Arguments -eq 'compose version --short') {
            return [pscustomobject] @{ Success = ($script:probeMode -ne "compose-failed"); Output = "2.0"; Error = "Compose unavailable" }
        }
        if ($script:probeMode -eq "offline") {
            return [pscustomobject] @{ Success = $false; Output = ""; Error = "Connection refused" }
        }
        $osType = "linux"
        if ($script:probeMode -eq "windows") { $osType = "windows" }
        if ($script:probeMode -eq "empty") { $osType = "" }
        return [pscustomobject] @{ Success = $true; Output = $osType; Error = "" }
    }
    Test-Scenario "Running Linux engine and Compose pass without launching Desktop" {
        Reset-Scenario
        $script:pathCommand = "docker.exe"
        Assert-Equal (Assert-DockerReady -NoStart) "docker.exe"
        Assert-Equal $script:probeCalls.Count 2
        Assert-Equal $script:startCalls 0
    }
    Test-Scenario "Stopped engine is not misreported as a missing installation" {
        Reset-Scenario
        $script:pathCommand = "docker.exe"
        $script:probeMode = "offline"
        Assert-Throws { Assert-DockerReady -NoStart } "found, but its engine is not reachable"
        Assert-Equal $script:startCalls 0
    }
    Test-Scenario "Windows containers are rejected before Compose or installation" {
        Reset-Scenario
        $script:pathCommand = "docker.exe"
        $script:probeMode = "windows"
        Assert-Throws { Assert-DockerReady -NoStart } "switch to Linux containers"
        Assert-Equal $script:probeCalls.Count 1
    }
    Test-Scenario "Empty engine response does not pass readiness" {
        Reset-Scenario
        $script:pathCommand = "docker.exe"
        $script:probeMode = "empty"
        Assert-Throws { Assert-DockerReady -NoStart } "not using Linux containers"
    }
    Test-Scenario "Missing Compose has its own actionable error" {
        Reset-Scenario
        $script:pathCommand = "docker.exe"
        $script:probeMode = "compose-failed"
        Assert-Throws { Assert-DockerReady -NoStart } "Compose is unavailable"
    }
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process") }
    if (Test-Path $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}

Write-Host "$script:passed passed; $script:failed failed."
if ($script:failed) { exit 1 }
