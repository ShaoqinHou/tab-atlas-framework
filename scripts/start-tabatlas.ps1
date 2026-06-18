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

$env:TABATLAS_PORT = [string]$Port
$env:TABATLAS_DB = $Database

$npm = (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)
if (-not $npm) { $npm = Get-Command "npm" }

Start-Process -FilePath $npm.Source -ArgumentList @("run", "dev") -WorkingDirectory $Root -WindowStyle Hidden

$Health = "http://127.0.0.1:$Port/health"
$Deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  try {
    $Response = Invoke-RestMethod -Uri $Health -Method Get -TimeoutSec 2
    if ($Response.ok) {
      Write-Host "TabAtlas receiver is running at http://127.0.0.1:$Port"
      if (-not $NoOpen) {
        Start-Process "http://127.0.0.1:$Port/"
      }
      exit 0
    }
  } catch {
    if ((Get-Date) -gt $Deadline) { throw "Receiver did not become healthy at $Health" }
  }
} while ((Get-Date) -le $Deadline)

throw "Receiver did not become healthy at $Health"
