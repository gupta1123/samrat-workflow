#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-SamratDockerDesktopPaths {
    # A new install may not be on this process's PATH yet. Check both official
    # installation modes, registered custom locations, and the running app.
    $roots = New-Object 'System.Collections.Generic.List[string]'
    foreach ($base in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($base) { $roots.Add((Join-Path $base "Docker\Docker")) }
    }
    if ($env:LOCALAPPDATA) {
        $roots.Add((Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop"))
    }

    foreach ($hive in @("HKCU", "HKLM")) {
        foreach ($key in @(
            "${hive}:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop",
            "${hive}:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop",
            "${hive}:\SOFTWARE\Docker Inc.\Docker Desktop"
        )) {
            $entry = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
            if (-not $entry) { continue }
            foreach ($name in @("InstallLocation", "InstallPath")) {
                $property = $entry.PSObject.Properties[$name]
                if ($property -and $property.Value) {
                    $roots.Add([Environment]::ExpandEnvironmentVariables(([string] $property.Value).Trim('"')))
                }
            }
        }
    }

    foreach ($process in @(Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) {
        try {
            if ($process.Path) { $roots.Add((Split-Path -Parent $process.Path)) }
        } catch {
            # Another account's process may not expose its executable path.
        }
    }

    foreach ($root in ($roots | Select-Object -Unique)) {
        $desktop = Join-Path $root "Docker Desktop.exe"
        if (Test-Path -LiteralPath $desktop -PathType Leaf) { $desktop }
    }
}

function Get-DockerCommand {
    foreach ($desktop in @(Get-SamratDockerDesktopPaths)) {
        $command = Join-Path (Split-Path -Parent $desktop) "resources\bin\docker.exe"
        if (Test-Path -LiteralPath $command -PathType Leaf) { return $command }
    }

    $command = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }

    throw "Docker's command-line tool could not be found for this Windows account. If Docker is already installed, start Docker Desktop and run Samrat setup using the same Windows account. Otherwise install Docker Desktop with its WSL 2 engine."
}

function Invoke-SamratDockerProbe {
    param(
        [Parameter(Mandatory = $true)][string] $DockerPath,
        [Parameter(Mandatory = $true)][string] $Arguments,
        [int] $TimeoutSeconds = 15
    )

    # Read only: no containers, images, contexts, or Docker settings are changed.
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo.FileName = $DockerPath
    $process.StartInfo.Arguments = $Arguments
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        $null = $process.Start()
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            return [pscustomobject] @{ Success = $false; Output = ""; Error = "Docker did not respond within $TimeoutSeconds seconds." }
        }
        return [pscustomobject] @{
            Success = ($process.ExitCode -eq 0)
            Output = $outputTask.Result.Trim()
            Error = $errorTask.Result.Trim()
        }
    } catch {
        return [pscustomobject] @{ Success = $false; Output = ""; Error = $_.Exception.Message }
    } finally {
        $process.Dispose()
    }
}

function Assert-DockerReady {
    param([switch] $NoStart)

    $docker = Get-DockerCommand
    $engine = Invoke-SamratDockerProbe -DockerPath $docker -Arguments 'info --format "{{.OSType}}"'
    if (-not $engine.Success -and -not $NoStart) {
        $desktop = Get-SamratDockerDesktopPaths | Select-Object -First 1
        if ($desktop) {
            Write-Host "Starting Docker Desktop..." -ForegroundColor Yellow
            Start-Process -FilePath $desktop
            $deadline = (Get-Date).AddMinutes(3)
            do {
                Start-Sleep -Seconds 3
                $engine = Invoke-SamratDockerProbe -DockerPath $docker -Arguments 'info --format "{{.OSType}}"'
            } while (-not $engine.Success -and (Get-Date) -lt $deadline)
        }
    }

    if (-not $engine.Success) {
        throw "Docker was found, but its engine is not reachable from this Windows account. Open Docker Desktop, wait for Engine running, and retry. If Windows requested a different administrator account, Docker and Samrat must be accessible to that account too. Details: $($engine.Error)"
    }
    if ($engine.Output -cne "linux") {
        throw "Docker is running, but it is not using Linux containers. In Docker Desktop, switch to Linux containers and enable the WSL 2 based engine, then retry."
    }

    $compose = Invoke-SamratDockerProbe -DockerPath $docker -Arguments 'compose version --short'
    if (-not $compose.Success) {
        throw "Docker is running, but Docker Compose is unavailable. Repair or update Docker Desktop, then retry. Details: $($compose.Error)"
    }
    return $docker
}
