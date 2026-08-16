param(
    [ValidateSet("cursor", "codex")]
    [string]$Agent = $(if ($env:GAA_GROK_AGENT) { $env:GAA_GROK_AGENT } else { "cursor" }),

    [int]$Port = 0,

    [string]$Url = "https://grok.com/imagine",

    [string]$ChromePath,

    [string]$ProfileDir,

    [switch]$Headless,

    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is unavailable; refusing to place a persistent browser profile in the repository."
}

$agentDefaults = @{
    cursor = @{ Port = 9334; ProfileName = "ChromeProfileCursor" }
    codex = @{ Port = 9333; ProfileName = "ChromeProfile" }
}
if (-not $agentDefaults.ContainsKey($Agent)) {
    throw "Unknown Agent: $Agent. Use cursor or codex."
}
if ($Port -le 0) {
    if ($env:GAA_GROK_CDP_PORT) { $Port = [int]$env:GAA_GROK_CDP_PORT }
    else { $Port = $agentDefaults[$Agent].Port }
}
if ($Port -lt 1024 -or $Port -gt 65535) {
    throw "Port must be between 1024 and 65535."
}
$nextRoot = Join-Path $env:LOCALAPPDATA "GameAssetsAutomation\GrokCdp"
$legacyRoot = Join-Path $env:LOCALAPPDATA "VESPERIX\GrokCdp"
if ($env:GAA_GROK_STATE_ROOT) { $stateRoot = $env:GAA_GROK_STATE_ROOT }
elseif ($env:VESPERIX_GROK_STATE_ROOT) { $stateRoot = $env:VESPERIX_GROK_STATE_ROOT }
elseif ((Test-Path -LiteralPath $nextRoot) -or -not (Test-Path -LiteralPath $legacyRoot)) { $stateRoot = $nextRoot }
else { $stateRoot = $legacyRoot }
if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    if ($env:GAA_GROK_PROFILE_DIR) { $ProfileDir = $env:GAA_GROK_PROFILE_DIR }
    else { $ProfileDir = Join-Path $stateRoot $agentDefaults[$Agent].ProfileName }
}
$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)
$stateFile = Join-Path $stateRoot "session.json"

function Resolve-ChromeExecutable {
    param([string]$ExplicitPath)

    if ($ExplicitPath) {
        $resolved = [System.IO.Path]::GetFullPath($ExplicitPath)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "Chrome executable not found: $resolved"
        }
        return $resolved
    }

    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    throw "Google Chrome was not found in the standard Windows locations. Pass -ChromePath explicitly."
}

function Get-DedicatedChromeProcesses {
    param([string]$ExpectedProfileDir, [int]$ExpectedPort)

    $quotedProfileNeedle = "--user-data-dir=`"$ExpectedProfileDir`""
    $bareProfileNeedle = "--user-data-dir=$ExpectedProfileDir"
    $portNeedle = "--remote-debugging-port=$ExpectedPort"
    return @(
        Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                if (-not $_.CommandLine) { return $false }
                $profileMatches =
                    $_.CommandLine.IndexOf($quotedProfileNeedle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                    $_.CommandLine.IndexOf($bareProfileNeedle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
                return $profileMatches -and
                    $_.CommandLine.IndexOf($portNeedle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            }
    )
}

function Test-CdpEndpoint {
    param([int]$EndpointPort)

    try {
        $result = Invoke-RestMethod -Uri "http://127.0.0.1:$EndpointPort/json/version" -TimeoutSec 2
        return $null -ne $result.webSocketDebuggerUrl
    }
    catch {
        return $false
    }
}

$ChromePath = Resolve-ChromeExecutable -ExplicitPath $ChromePath
[System.IO.Directory]::CreateDirectory($stateRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($ProfileDir) | Out-Null
[System.IO.Directory]::CreateDirectory((Join-Path $stateRoot "captures")) | Out-Null

$existing = Get-DedicatedChromeProcesses -ExpectedProfileDir $ProfileDir -ExpectedPort $Port
if (Test-CdpEndpoint -EndpointPort $Port) {
    if ($existing.Count -eq 0) {
        throw "CDP port $Port is already in use by a process that does not match the dedicated Grok profile."
    }

    [ordered]@{
        status = "already_running"
        port = $Port
        profileDir = $ProfileDir
        processIds = @($existing.ProcessId)
        browserUrl = "http://127.0.0.1:$Port"
    } | ConvertTo-Json -Depth 4
    exit 0
}

$arguments = @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    "--user-data-dir=`"$ProfileDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--window-size=1600,1000"
)
if ($Headless) {
    $arguments += "--headless=new"
}
if (-not $NoOpen) {
    $parsedUrl = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$parsedUrl)) {
        throw "Url must be absolute: $Url"
    }
    $allowedHosts = @("grok.com", "x.com", "accounts.x.ai", "accounts.x.com")
    $hostAllowed = $false
    foreach ($allowedHost in $allowedHosts) {
        if ($parsedUrl.Host.Equals($allowedHost, [System.StringComparison]::OrdinalIgnoreCase) -or
            $parsedUrl.Host.EndsWith(".$allowedHost", [System.StringComparison]::OrdinalIgnoreCase)) {
            $hostAllowed = $true
            break
        }
    }
    if ($parsedUrl.Scheme -notin @("http", "https") -or -not $hostAllowed) {
        throw "Url must use HTTP(S) and a Grok/X service host: $Url"
    }
    $arguments += $Url
}

$process = Start-Process -FilePath $ChromePath -ArgumentList $arguments -PassThru -WindowStyle Normal

$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-CdpEndpoint -EndpointPort $Port) {
        break
    }
    Start-Sleep -Milliseconds 250
}
if (-not (Test-CdpEndpoint -EndpointPort $Port)) {
    throw "Chrome started with PID $($process.Id), but CDP did not become ready on 127.0.0.1:$Port within 20 seconds."
}

$session = [ordered]@{
    schemaVersion = 1
    status = "running"
    launchedAtUtc = [DateTime]::UtcNow.ToString("o")
    chromePath = $ChromePath
    profileDir = $ProfileDir
    port = $Port
    launcherProcessId = $process.Id
    browserUrl = "http://127.0.0.1:$Port"
    capturesDir = (Join-Path $stateRoot "captures")
}
$session | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stateFile -Encoding UTF8
$session | ConvertTo-Json -Depth 4
