param(
  [string]$Database = "",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $Database) {
  $Database = Join-Path $Root "data\tabatlas.sqlite"
}
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $Root "backups"
}
if (-not (Test-Path $Database)) {
  throw "Database not found: $Database"
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Target = Join-Path $OutputDirectory "tabatlas-$Timestamp.sqlite"
$NodeScript = @"
(async () => {
  const Database = require('better-sqlite3');
  const source = process.argv[1];
  const target = process.argv[2];
  const db = new Database(source, { readonly: true, fileMustExist: true });
  await db.backup(target);
  db.close();
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
"@

node -e $NodeScript $Database $Target
Write-Host "Backup written to $Target"
