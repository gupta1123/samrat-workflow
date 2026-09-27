. "$PSScriptRoot\Common.ps1"

function New-RandomBytes {
    param([int] $Length)
    $bytes = New-Object byte[] $Length
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return $bytes
}

function ConvertTo-Base64Url {
    param([byte[]] $Bytes)
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomBase64Url {
    param([int] $Length)
    return (ConvertTo-Base64Url (New-RandomBytes $Length))
}

function New-RandomHex {
    param([int] $Length)
    return -join ((New-RandomBytes $Length) | ForEach-Object { $_.ToString('x2') })
}

function New-SupabaseJwt {
    param(
        [Parameter(Mandatory = $true)][string] $Role,
        [Parameter(Mandatory = $true)][string] $Secret
    )

    $utf8 = [Text.Encoding]::UTF8
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = ConvertTo-Base64Url ($utf8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
    $payloadObject = [ordered]@{
        role = $Role
        iss = "supabase"
        iat = $now
        exp = $now + (10 * 365 * 24 * 60 * 60)
    }
    $payloadJson = $payloadObject | ConvertTo-Json -Compress
    $payload = ConvertTo-Base64Url ($utf8.GetBytes($payloadJson))
    $unsigned = "$header.$payload"
    $hmac = New-Object Security.Cryptography.HMACSHA256
    try {
        $hmac.Key = $utf8.GetBytes($Secret)
        $signature = ConvertTo-Base64Url ($hmac.ComputeHash($utf8.GetBytes($unsigned)))
    } finally {
        $hmac.Dispose()
    }
    return "$unsigned.$signature"
}

function Assert-DotEnvValue {
    param([string] $Name, [string] $Value)
    if ($Value -match "[`r`n]") { throw "$Name cannot contain a line break." }
}

function Normalize-OpenRouterApiKey {
    param([AllowEmptyString()][string] $Value)

    if ($null -eq $Value) { return "" }
    $normalized = $Value.Trim()

    # Accept a value copied from an environment editor, then remove formatting
    # characters that messaging and remote-desktop clipboards can insert.
    $normalized = [Regex]::Replace(
        $normalized,
        '^\s*OPENROUTER_API_KEY\s*=\s*',
        '',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    $normalized = [Regex]::Replace($normalized, '[\u2018\u2019\u201C\u201D]', '')

    # Clipboard tools sometimes include matching quotes around copied secrets.
    if ($normalized.Length -ge 2) {
        $first = $normalized[0]
        $last = $normalized[$normalized.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $normalized = $normalized.Substring(1, $normalized.Length - 2).Trim()
        }
    }

    # OpenRouter keys do not contain whitespace or Unicode formatting/control
    # characters. Removing these repairs wrapped chat and remote-clipboard text
    # without changing any valid key character.
    $normalized = [Regex]::Replace($normalized, '[\p{Cc}\p{Cf}\p{Z}]', '')

    return $normalized
}

function Assert-OpenRouterApiKey {
    param([AllowEmptyString()][string] $Value)

    $normalized = Normalize-OpenRouterApiKey $Value
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        throw "An OpenRouter API key is required for document analysis."
    }

    # The Bearer value must be visible ASCII. This rejects copied line breaks,
    # smart punctuation, zero-width characters, and other unsafe characters.
    if ($normalized -notmatch '^sk-or-v1-[A-Za-z0-9_-]{20,}$') {
        throw "The pasted value is not a valid OpenRouter API key. Copy the complete key beginning with sk-or-v1- and paste it again."
    }

    return $normalized
}

function Set-DotEnvValue {
    param([string] $Content, [string] $Name, [string] $Value)
    Assert-DotEnvValue $Name $Value
    $replacement = "$Name=$Value"
    $pattern = "(?m)^" + [Regex]::Escape($Name) + "=.*$"
    if ([Regex]::IsMatch($Content, $pattern)) {
        return [Regex]::Replace($Content, $pattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement })
    }
    return $Content.TrimEnd() + [Environment]::NewLine + $replacement + [Environment]::NewLine
}

function Set-SamratOpenRouterApiKey {
    param(
        [Parameter(Mandatory = $true)][string] $EnvironmentPath,
        [Parameter(Mandatory = $true)][string] $OpenRouterApiKey
    )

    if (-not (Test-Path -LiteralPath $EnvironmentPath)) {
        throw "The Samrat environment file is missing."
    }

    $normalized = Assert-OpenRouterApiKey $OpenRouterApiKey
    $content = [IO.File]::ReadAllText($EnvironmentPath)
    $content = Set-DotEnvValue $content "OPENROUTER_API_KEY" $normalized
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($EnvironmentPath, $content, $utf8NoBom)
    return $normalized
}

function New-SamratEnvironment {
    param([Parameter(Mandatory = $true)][string] $OpenRouterApiKey)

    $OpenRouterApiKey = Assert-OpenRouterApiKey $OpenRouterApiKey

    $supabaseRoot = Get-SupabaseRoot
    $versionPath = Join-Path (Get-SamratRoot) "payload\version.txt"
    $templatePath = Join-Path $supabaseRoot ".env.example"
    $environmentPath = Join-Path $supabaseRoot ".env"
    if (-not (Test-Path $templatePath)) { throw "Supabase environment template is missing." }
    if (-not (Test-Path $versionPath)) { throw "Samrat package version is missing." }
    $packageVersion = ([IO.File]::ReadAllText($versionPath)).Trim()
    if ($packageVersion -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
        throw "Samrat package version is invalid."
    }

    $jwtSecret = New-RandomBase64Url 48
    $settings = [ordered]@{
        COMPOSE_FILE = "docker-compose.yml"
        POSTGRES_PASSWORD = (New-RandomBase64Url 36)
        JWT_SECRET = $jwtSecret
        ANON_KEY = (New-SupabaseJwt "anon" $jwtSecret)
        SERVICE_ROLE_KEY = (New-SupabaseJwt "service_role" $jwtSecret)
        SUPABASE_PUBLISHABLE_KEY = ""
        SUPABASE_SECRET_KEY = ""
        JWT_KEYS = ""
        JWT_JWKS = ""
        DASHBOARD_USERNAME = "samrat-admin"
        DASHBOARD_PASSWORD = (New-RandomBase64Url 24)
        SECRET_KEY_BASE = (New-RandomBase64Url 64)
        REALTIME_DB_ENC_KEY = (New-RandomHex 8)
        VAULT_ENC_KEY = (New-RandomHex 16)
        PG_META_CRYPTO_KEY = (New-RandomBase64Url 32)
        LOGFLARE_PUBLIC_ACCESS_TOKEN = (New-RandomBase64Url 32)
        LOGFLARE_PRIVATE_ACCESS_TOKEN = (New-RandomBase64Url 32)
        S3_PROTOCOL_ACCESS_KEY_ID = (New-RandomHex 16)
        S3_PROTOCOL_ACCESS_KEY_SECRET = (New-RandomHex 32)
        SUPABASE_PUBLIC_URL = "http://localhost:8000"
        API_EXTERNAL_URL = "http://localhost:8000/auth/v1"
        SITE_URL = "http://localhost:8888"
        ADDITIONAL_REDIRECT_URLS = "http://localhost:8888/**"
        DISABLE_SIGNUP = "true"
        ENABLE_EMAIL_SIGNUP = "true"
        ENABLE_EMAIL_AUTOCONFIRM = "true"
        ENABLE_ANONYMOUS_USERS = "false"
        ENABLE_PHONE_SIGNUP = "false"
        ENABLE_PHONE_AUTOCONFIRM = "false"
        STUDIO_DEFAULT_ORGANIZATION = "Samrat Group"
        STUDIO_DEFAULT_PROJECT = "Samrat Case Review"
        OPENAI_API_KEY = ""
        SAMRAT_VERSION = $packageVersion
        SAMRAT_APP_PORT = "8888"
        OPENROUTER_API_KEY = $OpenRouterApiKey
        OPENROUTER_MODEL = "google/gemini-2.5-flash"
        OPENROUTER_QUALITY_MODEL = "google/gemini-2.5-flash"
        OPENROUTER_REVIEW_MODEL = "google/gemini-2.5-flash"
        OPENROUTER_REVIEW_REASONING_EFFORT = "high"
        OPENROUTER_QUALITY_REASONING_TOKENS = "2000"
        OPENROUTER_MAX_OUTPUT_TOKENS = "8192"
        OPENROUTER_REVIEW_MAX_OUTPUT_TOKENS = "4096"
        OPENROUTER_MAX_RETRIES = "2"
        OPENROUTER_RETRY_BASE_MS = "1200"
        OPENROUTER_TIMEOUT_MS = "60000"
        WORKER_SECRET = (New-RandomBase64Url 32)
    }

    $content = [IO.File]::ReadAllText($templatePath)
    foreach ($entry in $settings.GetEnumerator()) {
        $content = Set-DotEnvValue $content $entry.Key ([string]$entry.Value)
    }

    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($environmentPath, $content, $utf8NoBom)
    return $environmentPath
}
