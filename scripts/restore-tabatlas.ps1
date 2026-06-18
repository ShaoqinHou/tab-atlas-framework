param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,
  [string]$Database = "",
  [int]$Port = 9787
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $Database) {
  $Database = Join-Path $Root "data\tabatlas.sqlite"
}
if (-not (Test-Path $BackupPath)) {
  throw "Backup not found: $BackupPath"
}

$Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($Listening) {
  throw "TabAtlas appears to be running on port $Port. Stop the receiver before restoring."
}

New-Item -ItemType Directory -Force -Path (Split-Path $Database -Parent) | Out-Null
if (Test-Path $Database) {
  $Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $PreRestore = "$Database.pre-restore-$Timestamp"
  Copy-Item -LiteralPath $Database -Destination $PreRestore -Force
  Write-Host "Existing database copied to $PreRestore"
}

Copy-Item -LiteralPath $BackupPath -Destination $Database -Force
Write-Host "Restored $BackupPath to $Database"
