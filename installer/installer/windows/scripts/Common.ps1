Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-SamratRoot {
    return (Split-Path -Parent $PSScriptRoot)
}

function Get-SupabaseRoot {
    return (Join-Path (Get-SamratRoot) "runtime\supabase")
}

function Get-DockerCommand {
    $command = Get-Command docker -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $desktopDocker = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe"
    if (Test-Path $desktopDocker) { return $desktopDocker }

    throw "Docker Desktop is not installed. Install Docker Desktop with WSL 2, start it, then run this action again."
}

function Assert-DockerReady {
    $docker = Get-DockerCommand
    & $docker info *> $null
    if ($LASTEXITCODE -eq 0) { return $docker }

    $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path $desktop) {
        Write-Host "Starting Docker Desktop..." -ForegroundColor Yellow
        Start-Process $desktop
        $deadline = (Get-Date).AddMinutes(3)
        do {
            Start-Sleep -Seconds 3
            & $docker info *> $null
            if ($LASTEXITCODE -eq 0) { return $docker }
        } while ((Get-Date) -lt $deadline)
    }

    throw "Docker Desktop is installed but its engine is not running. Start Docker Desktop, wait for Engine running, and run this action again."
}

function Invoke-SamratCompose {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments
    )

    $docker = Assert-DockerReady
    $supabaseRoot = Get-SupabaseRoot
    $environmentFile = Join-Path $supabaseRoot ".env"
    if (-not (Test-Path $environmentFile)) {
        throw "Samrat is not configured yet. Run Install Samrat first."
    }

    $composeArguments = @(
        "compose",
        "--env-file", $environmentFile,
        "-f", (Join-Path $supabaseRoot "docker-compose.yml"),
        "-f", (Join-Path $supabaseRoot "docker-compose.pg17.yml"),
        "-f", (Join-Path $supabaseRoot "docker-compose.samrat.yml")
    ) + $Arguments

    & $docker @composeArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose failed with exit code $LASTEXITCODE."
    }
}

function Read-DotEnv {
    param([Parameter(Mandatory = $true)][string] $Path)

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $key, $value = $line -split '=', 2
        $values[$key.Trim()] = $value.Trim()
    }
    return $values
}

function Assert-SamratImageArchive {
    param(
        [Parameter(Mandatory = $true)][string] $ArchivePath,
        [Parameter(Mandatory = $true)][string] $ChecksumPath
    )

    if (-not (Test-Path -LiteralPath $ArchivePath) -or -not (Test-Path -LiteralPath $ChecksumPath)) {
        throw "The installer image payload or its checksum is missing."
    }

    $checksumLine = ([IO.File]::ReadAllText($ChecksumPath)).Trim()
    $expected = ($checksumLine -split '\s+')[0].ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') {
        throw "The installer image checksum is invalid."
    }

    Write-Host "Verifying the Samrat application payload..."
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
    if ($actual -cne $expected) {
        throw "The Samrat application payload is damaged or incomplete. Re-download the installer before continuing."
    }
}

function Wait-SamratUrl {
    param(
        [Parameter(Mandatory = $true)][string] $Url,
        [int] $TimeoutSeconds = 300
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
        } catch {
            Start-Sleep -Seconds 2
        }
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for $Url. Run Samrat Status to inspect the services."
}

function Set-SamratFirewallRules {
    $ruleName = "Samrat Case Review - Private Network"
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existing) { Remove-NetFirewallRule -DisplayName $ruleName }
    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort 8000, 8888 `
        -Profile Private `
        -RemoteAddress LocalSubnet | Out-Null
}

function ConvertFrom-SecureValue {
    param([Parameter(Mandatory = $true)][Security.SecureString] $Value)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}
