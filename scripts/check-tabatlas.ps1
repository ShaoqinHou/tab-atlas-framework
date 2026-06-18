param(
  [int]$Port = 9787,
  [string]$Database = "",
  [string]$AdminToken = $env:TABATLAS_ACCEPTANCE_ADMIN_TOKEN
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $Database) {
  $Database = Join-Path $Root "data\tabatlas.sqlite"
}

$Checks = @()
foreach ($Name in @("node", "npm")) {
  $Checks += [pscustomobject]@{ Check = $Name; Ok = [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
}
$Checks += [pscustomobject]@{ Check = "codex"; Ok = [bool](Get-Command "codex" -ErrorAction SilentlyContinue) }
$Checks += [pscustomobject]@{ Check = "database parent"; Ok = Test-Path (Split-Path $Database -Parent) }

$Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$Checks += [pscustomobject]@{ Check = "port $Port listening"; Ok = [bool]$Listening }

try {
  $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Method Get -TimeoutSec 2
  $Checks += [pscustomobject]@{ Check = "receiver health"; Ok = [bool]$Health.ok }
} catch {
  $Checks += [pscustomobject]@{ Check = "receiver health"; Ok = $false }
}

if ($AdminToken) {
  try {
    $Headers = @{ "x-tab-atlas-token" = $AdminToken }
    $Status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/security/status" -Headers $Headers -Method Get -TimeoutSec 5
    $Checks += [pscustomobject]@{ Check = "capture roots configured"; Ok = ($Status.captureRoots.Count -ge 0) }
  } catch {
    $Checks += [pscustomobject]@{ Check = "admin status"; Ok = $false }
  }
}

$Checks | Format-Table -AutoSize
if ($Checks.Ok -contains $false) { exit 1 }
