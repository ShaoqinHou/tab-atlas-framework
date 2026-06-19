param(
  [int]$Port = 9787,
  [string]$Database = "",
  [string]$AdminToken = $env:TABATLAS_ACCEPTANCE_ADMIN_TOKEN
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root
if (-not $Database) {
  $Database = Join-Path $Root "data\tabatlas.sqlite"
}

$Checks = @()
foreach ($Name in @("node", "npm")) {
  $Checks += [pscustomobject]@{ Check = $Name; Ok = [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
}
$Checks += [pscustomobject]@{ Check = "codex"; Ok = [bool](Get-Command "codex" -ErrorAction SilentlyContinue) }
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$Checks += [pscustomobject]@{ Check = "codex auth file"; Ok = (Test-Path (Join-Path $CodexHome "auth.json")) }
$Checks += [pscustomobject]@{ Check = "database parent"; Ok = Test-Path (Split-Path $Database -Parent) }
$Checks += [pscustomobject]@{ Check = "database file"; Ok = Test-Path $Database }

if (Test-Path $Database) {
  $DbCheckScript = @'
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
const integrity = db.pragma('integrity_check', { simple: true });
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
const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
const names = new Set(rows.map(row => row.name));
const missing = required.filter(name => !names.has(name));
db.close();
if (integrity !== 'ok') {
  console.error(`integrity_check=${integrity}`);
  process.exit(2);
}
if (missing.length) {
  console.error(`missing tables: ${missing.join(', ')}`);
  process.exit(3);
}
'@
  $DbIntegrity = (& node -e $DbCheckScript $Database)
  $Checks += [pscustomobject]@{ Check = "database integrity and tables"; Ok = ($LASTEXITCODE -eq 0) }
} else {
  $Checks += [pscustomobject]@{ Check = "database integrity and tables"; Ok = $false }
}

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

$ReleaseManifest = Join-Path $Root "release\release-manifest.json"
if (Test-Path $ReleaseManifest) {
  try {
    $Manifest = Get-Content -Path $ReleaseManifest -Raw | ConvertFrom-Json
    $HashOk = $true
    foreach ($Package in $Manifest.packages) {
      if ($Package.exists -and $Package.sha256) {
        $PackagePath = Join-Path $Root $Package.path
        if (-not (Test-Path $PackagePath)) {
          $HashOk = $false
          continue
        }
        $Actual = (Get-FileHash -Algorithm SHA256 -Path $PackagePath).Hash.ToLowerInvariant()
        if ($Actual -ne $Package.sha256) { $HashOk = $false }
      }
    }
    $Checks += [pscustomobject]@{ Check = "release manifest"; Ok = $true }
    $Checks += [pscustomobject]@{ Check = "release package hashes"; Ok = $HashOk }
  } catch {
    $Checks += [pscustomobject]@{ Check = "release manifest"; Ok = $false }
    $Checks += [pscustomobject]@{ Check = "release package hashes"; Ok = $false }
  }
} else {
  $Checks += [pscustomobject]@{ Check = "release manifest"; Ok = $false }
  $Checks += [pscustomobject]@{ Check = "release package hashes"; Ok = $false }
}

$npm = (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)
if (-not $npm) { $npm = Get-Command "npm" -ErrorAction SilentlyContinue }
if ($npm) {
  & $npm.Source --silent run acceptance:ports | Out-Null
  $Checks += [pscustomobject]@{ Check = "extension receiver compatibility"; Ok = ($LASTEXITCODE -eq 0) }
} else {
  $Checks += [pscustomobject]@{ Check = "extension receiver compatibility"; Ok = $false }
}

$Checks | Format-Table -AutoSize
if ($Checks.Ok -contains $false) { exit 1 }
