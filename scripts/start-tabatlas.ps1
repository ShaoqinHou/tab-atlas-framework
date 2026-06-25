param(
  [ValidateSet("production", "roleplay", "acceptance", "development", "test")]
  [string]$Profile = "production",
  [int]$Port = 9787,
  [string]$Database = "",
  [string]$BootstrapDirectory = "",
  [string]$InstanceName = "",
  [switch]$InitializeIdentity,
  [switch]$RecoverStaleLease,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required but was not found on PATH."
  }
}

function Redact-Path($PathValue) {
  $resolved = [System.IO.Path]::GetFullPath($PathValue)
  $hash = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($resolved.ToLowerInvariant()))
  ).Replace("-", "").Substring(0, 12).ToLowerInvariant()
  return "$([System.IO.Path]::GetFileName($resolved)) sha256:$hash"
}

Require-Command "node"
Require-Command "npm"

if (-not $Database) {
  if ($Profile -ne "production") {
    throw "-Database is required for $Profile profile."
  }
  $Database = Join-Path $Root "data\tabatlas.sqlite"
}
if (-not $BootstrapDirectory) {
  $BootstrapDirectory = Join-Path (Split-Path $Database -Parent) "bootstrap"
}
if (-not $InstanceName) {
  $InstanceName = "tabatlas-$Profile-$Port"
}

$Health = "http://127.0.0.1:$Port/health"
$AppUrl = "http://127.0.0.1:$Port/"
$LocalDir = Join-Path $Root ".local"
$LogDir = Join-Path $LocalDir "logs"
$PidPath = Join-Path $LocalDir "tabatlas-server-$Profile-$Port.pid"
$InfoPath = Join-Path $LocalDir "tabatlas-server-$Profile-$Port.json"
$StdoutPath = Join-Path $LogDir "tabatlas-server-$Profile-$Port.out.log"
$StderrPath = Join-Path $LogDir "tabatlas-server-$Profile-$Port.err.log"

function Test-ReceiverHealth($Uri) {
  try {
    $Response = Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 2
    return [bool]$Response.ok
  } catch {
    return $false
  }
}

if (Test-ReceiverHealth $Health) {
  Write-Host "TabAtlas receiver is already running at $AppUrl"
  if (-not $NoOpen) {
    Start-Process $AppUrl
  }
  exit 0
}

$Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($Listening) {
  throw "Port $Port is already listening but $Health is not healthy. Stop that process or use -Port."
}

New-Item -ItemType Directory -Force -Path (Split-Path $Database -Parent) | Out-Null
New-Item -ItemType Directory -Force -Path $BootstrapDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "Starting TabAtlas"
Write-Host "Profile: $Profile"
Write-Host "Port: $Port"
Write-Host "Database: $(Redact-Path $Database)"
Write-Host "Instance: $InstanceName"

$env:TABATLAS_RUNTIME_PROFILE = $Profile
$env:TABATLAS_PORT = [string]$Port
$env:TABATLAS_DB = $Database
$env:TABATLAS_BOOTSTRAP_DIR = $BootstrapDirectory
$env:TABATLAS_INSTANCE_NAME = $InstanceName
$env:TABATLAS_ALLOW_IDENTITY_INIT = if ($InitializeIdentity) { "1" } else { "" }
$env:TABATLAS_RECOVER_STALE_LEASE = if ($RecoverStaleLease) { "1" } else { "" }

$npm = (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)
if (-not $npm) { $npm = Get-Command "npm" }

$Process = Start-Process `
  -FilePath $npm.Source `
  -ArgumentList @("run", "dev") `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutPath `
  -RedirectStandardError $StderrPath `
  -PassThru

[string]$Process.Id | Set-Content -Path $PidPath
@{
  pid = $Process.Id
  profile = $Profile
  port = $Port
  database = Redact-Path $Database
  url = $AppUrl
  stdout = $StdoutPath
  stderr = $StderrPath
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -Path $InfoPath

$Deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  if ($Process.HasExited) {
    throw "Receiver process exited early with code $($Process.ExitCode). Logs: $StdoutPath $StderrPath"
  }
  if (Test-ReceiverHealth $Health) {
    Write-Host "TabAtlas receiver is running at $AppUrl"
    Write-Host "PID: $($Process.Id)"
    Write-Host "Logs: $StdoutPath"
    Write-Host "Errors: $StderrPath"
    if (-not $NoOpen) {
      Start-Process $AppUrl
    }
    exit 0
  }
} while ((Get-Date) -le $Deadline)

throw "Receiver did not become healthy at $Health. Logs: $StdoutPath $StderrPath"
