[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet("cursor", "codex")]
    [string]$Agent = $(if ($env:GAA_GROK_AGENT) { $env:GAA_GROK_AGENT } else { "cursor" }),

    [int]$Port = 0,

    [string]$ProfileDir,

    [switch]$Force
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$worker = Join-Path $scriptRoot "grok-cdp-worker.mjs"
$agentDefaults = @{
    cursor = @{ Port = 9334; ProfileName = "ChromeProfileCursor" }
    codex = @{ Port = 9333; ProfileName = "ChromeProfile" }
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

function Get-DedicatedChromeProcesses {
    $quotedProfileNeedle = "--user-data-dir=`"$ProfileDir`""
    $bareProfileNeedle = "--user-data-dir=$ProfileDir"
    $portNeedle = "--remote-debugging-port=$Port"
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

$processes = Get-DedicatedChromeProcesses
if ($processes.Count -eq 0) {
    [ordered]@{ status = "not_running"; port = $Port; profileDir = $ProfileDir } | ConvertTo-Json
    exit 0
}

if ($PSCmdlet.ShouldProcess("dedicated Grok Chrome profile at $ProfileDir", "Close browser")) {
    try {
        & node.exe $worker close-browser --port $Port | Out-Null
    }
    catch {
        Write-Warning "Graceful Browser.close failed: $($_.Exception.Message)"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 250
        $remaining = Get-DedicatedChromeProcesses
    } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)

    if ($remaining.Count -gt 0 -and $Force) {
        foreach ($item in $remaining) {
            Stop-Process -Id $item.ProcessId -Force
        }
        $remaining = @()
    }

    [ordered]@{
        status = if ($remaining.Count -eq 0) { "stopped" } else { "still_running" }
        port = $Port
        profileDir = $ProfileDir
        remainingProcessIds = @($remaining | ForEach-Object { $_.ProcessId })
        hint = if ($remaining.Count -gt 0) { "Close the dedicated Chrome window, or rerun with -Force." } else { $null }
    } | ConvertTo-Json -Depth 4
}
