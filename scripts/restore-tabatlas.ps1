param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,
  [string]$Database = "",
  [int]$Port = 9787,
  [string]$EvidencePath = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Get-DatabaseEvidence {
  param([string]$DatabasePath)
  $InspectScript = @'
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
const required = ['snapshots', 'resources', 'tab_observations', 'local_capabilities', 'manual_browser_acceptance_sessions'];
const integrity = db.pragma('integrity_check');
const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => row.name));
const count = table => tables.has(table) ? db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count : 0;
console.log(JSON.stringify({
  integrityOk: integrity.length === 1 && integrity[0].integrity_check === 'ok',
  requiredTablesPresent: required.filter(table => tables.has(table)),
  snapshotCount: count('snapshots'),
  resourceCount: count('resources')
}));
db.close();
'@
  $Raw = node -e $InspectScript $DatabasePath
  return $Raw | ConvertFrom-Json
}

if (-not $Database) {
  $Database = Join-Path $Root "data\tabatlas.sqlite"
}
if (-not (Test-Path $BackupPath)) {
  throw "Backup not found: $BackupPath"
}

$Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$ServerStopped = -not [bool]$Listening
if (-not $ServerStopped) {
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

$SourceEvidence = Get-DatabaseEvidence -DatabasePath $BackupPath
$RestoredEvidence = Get-DatabaseEvidence -DatabasePath $Database
$Payload = [ordered]@{
  backupPath = (Resolve-Path $BackupPath).Path
  backupSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $BackupPath).Hash.ToLowerInvariant()
  sourceDatabaseIntegrityOk = $SourceEvidence.integrityOk
  restoredDatabaseIntegrityOk = $RestoredEvidence.integrityOk
  requiredTablesPresent = $RestoredEvidence.requiredTablesPresent
  sourceSnapshotCount = $SourceEvidence.snapshotCount
  restoredSnapshotCount = $RestoredEvidence.snapshotCount
  sourceResourceCount = $SourceEvidence.resourceCount
  restoredResourceCount = $RestoredEvidence.resourceCount
  serverStoppedDuringRestore = $ServerStopped
  completedAt = (Get-Date).ToUniversalTime().ToString("o")
}
if ($EvidencePath) {
  New-Item -ItemType Directory -Force -Path (Split-Path $EvidencePath -Parent) | Out-Null
  $Payload | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -Path $EvidencePath
  Write-Host "Restore evidence written to $EvidencePath"
} else {
  $Payload | ConvertTo-Json -Depth 6
}
