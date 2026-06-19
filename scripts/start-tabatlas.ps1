param(
  [int]$Port = 9787,
  [string]$Database = "",
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

Require-Command "node"
Require-Command "npm"

if (-not $Database) {
  $Database = Join-Path $Root "data\tabatlas.sqlite"
}

$Health = "http://127.0.0.1:$Port/health"
$AppUrl = "http://127.0.0.1:$Port/"
$LocalDir = Join-Path $Root ".local"
$LogDir = Join-Path $LocalDir "logs"
$PidPath = Join-Path $LocalDir "tabatlas-server-$Port.pid"
$InfoPath = Join-Path $LocalDir "tabatlas-server-$Port.json"
$StdoutPath = Join-Path $LogDir "tabatlas-server-$Port.out.log"
$StderrPath = Join-Path $LogDir "tabatlas-server-$Port.err.log"

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
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$env:TABATLAS_PORT = [string]$Port
$env:TABATLAS_DB = $Database

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
  port = $Port
  database = $Database
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
