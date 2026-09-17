Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\DockerEnvironment.ps1"

function Get-SamratRoot {
    return (Split-Path -Parent $PSScriptRoot)
}

function Get-SupabaseRoot {
    return (Join-Path (Get-SamratRoot) "runtime\supabase")
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
        [int] $TimeoutSeconds = 300,
        [hashtable] $Headers = @{}
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest `
                -UseBasicParsing `
                -Uri $Url `
                -Headers $Headers `
                -TimeoutSec 5
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

function Assert-OpenRouterKeyReady {
    param([Parameter(Mandatory = $true)][string] $DockerPath)

    # This authenticated metadata endpoint verifies the key without sending a
    # document or running a model, so the readiness check has no inference cost.
    $validationScript = @'
fetch("https://openrouter.ai/api/v1/key", {
  headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY }
}).then(async response => {
  if (!response.ok) {
    console.error("OpenRouter rejected the API key (HTTP " + response.status + ").");
    process.exit(1);
  }
  console.log("OpenRouter API key verified.");
}).catch(error => {
  const detail = error && error.cause && error.cause.message
    ? error.cause.message
    : (error && error.message ? error.message : String(error));
  console.error("Could not contact OpenRouter: " + detail);
  process.exit(1);
});
'@

    # Send the JavaScript over stdin. Passing multiline JavaScript through
    # docker.exe's -e argument loses quotation marks on Windows PowerShell.
    $validationScript | & $DockerPath exec -i samrat-worker node
    if ($LASTEXITCODE -ne 0) {
        throw "The OpenRouter key check failed. Copy a current API key from OpenRouter and run Repair OpenRouter Key."
    }
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
