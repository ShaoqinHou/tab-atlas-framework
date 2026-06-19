param(
  [string]$Database = "",
  [string]$OutputDirectory = "",
  [string]$EvidencePath = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Get-DatabaseEvidence {
  param([string]$DatabasePath)
  $InspectScript = @'
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
const required = [
  'snapshots',
  'resources',
  'tab_observations',
  'extraction_artifacts',
  'atomic_items',
  'user_annotations',
  'user_commands',
  'views',
  'semantic_view_specs',
  'memberships',
  'review_queue_items',
  'agent_runs',
  'resource_fts',
  'resource_knowledge_state',
  'jobs',
  'job_items',
  'view_revisions',
  'membership_feedback',
  'resource_extraction_state',
  'membership_feedback_context',
  'conversation_threads',
  'conversation_messages',
  'agent_actions',
  'local_capabilities',
  'local_pairing_codes',
  'security_audit_events',
  'codex_provider_threads',
  'codex_prompt_manifests',
  'pairing_challenges',
  'pairing_exchange_limits',
  'onboarding_state',
  'onboarding_bootstrap_secrets',
  'local_sessions',
  'action_effects',
  'retrieval_runs',
  'review_sessions',
  'review_session_items',
  'manual_browser_acceptance_sessions',
  'hierarchical_planning_runs',
  'hierarchical_planning_chunks',
  'release_acceptance_runs',
];
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

$Evidence = Get-DatabaseEvidence -DatabasePath $Database
$BackupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Target).Hash.ToLowerInvariant()
$Payload = [ordered]@{
  backupPath = $Target
  backupSha256 = $BackupHash
  sourceDatabaseIntegrityOk = $Evidence.integrityOk
  requiredTablesPresent = $Evidence.requiredTablesPresent
  sourceSnapshotCount = $Evidence.snapshotCount
  sourceResourceCount = $Evidence.resourceCount
  completedAt = (Get-Date).ToUniversalTime().ToString("o")
}
if ($EvidencePath) {
  New-Item -ItemType Directory -Force -Path (Split-Path $EvidencePath -Parent) | Out-Null
  $Payload | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -Path $EvidencePath
  Write-Host "Backup evidence written to $EvidencePath"
} else {
  $Payload | ConvertTo-Json -Depth 6
}
