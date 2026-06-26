import fs from 'node:fs';
import { createConversationThread, getAgentAction, persistAgentTurnPlan, recoverInterruptedAgentActions, retryAgentAction } from '../src/agent/conversationService.js';
import { openDatabase } from '../src/db/index.js';
import { importSnapshot } from '../src/import/headlessSnapshot.js';

type EvalResult = {
  caseName: string;
  expected: string;
  actual: string;
  pass: boolean;
};

const db = openDatabase(':memory:');
const results: EvalResult[] = [];

try {
  seedResources();
  seedActions();
  results.push(recoveryClassifiesActions());
  results.push(await retryFailedAutomaticAction());
  results.push(uiLabelsAreDistinct());
  results.push(recoveryRecordsArePersisted());
} finally {
  db.close();
}

for (const result of results) {
  console.log(`Case: ${result.caseName}`);
  console.log(`Expected: ${result.expected}`);
  console.log(`Actual: ${result.actual}`);
  console.log(`Pass/fail: ${result.pass ? 'pass' : 'fail'}`);
  console.log('');
}

const failed = results.filter(result => !result.pass);
if (failed.length) {
  console.error(`Action lifecycle evaluation failed: ${failed.length}/${results.length} cases failed.`);
  process.exit(1);
}

console.log(`Action lifecycle evaluation passed: ${results.length}/${results.length} cases.`);

function seedResources(): void {
  importSnapshot(db, {
    capturedAt: '2026-06-25T00:00:00.000Z',
    tabs: [
      { browser: 'chrome', title: 'Runtime safety review fixture', url: 'https://example.test/runtime-safety' },
      { browser: 'chrome', title: 'Knowledge miner transcript fixture', url: 'https://example.test/transcripts' },
    ],
  }, 'action_lifecycle_eval');
}

function seedActions(): void {
  const thread = createConversationThread(db, 'action lifecycle eval');
  persistAgentTurnPlan(db, {
    threadId: thread.id,
    plan: {
      reply: 'seeded lifecycle actions',
      questions: [],
      assumptions: [],
      actions: [{
        id: 'act_plan_view_running',
        kind: 'plan_view',
        approval: 'preview',
        rationale: 'restart during plan view',
        commandText: 'Plan runtime safety view',
        candidateLimit: 25,
      }, {
        id: 'act_refine_view_running',
        kind: 'refine_view',
        approval: 'preview',
        rationale: 'restart during refine view',
        viewId: 'view_missing_for_recovery',
        instruction: 'Tighten runtime safety evidence.',
      }, {
        id: 'act_scan_confirm',
        kind: 'scan_resources',
        approval: 'confirm',
        rationale: 'scan creation requires confirmation',
        resourceIds: resourceIds().slice(0, 1),
        limit: 1,
        force: false,
      }, {
        id: 'act_review_auto',
        kind: 'start_review',
        approval: 'automatic',
        rationale: 'review creation should start automatically',
        queue: 'unmarked',
      }, {
        id: 'act_annotation_confirm',
        kind: 'add_annotation',
        approval: 'confirm',
        rationale: 'annotation requires confirmation',
        resourceId: resourceIds()[0],
        tags: ['runtime-safety'],
        description: 'Seeded annotation action.',
        decision: 'project_reference',
      }, {
        id: 'act_accept_confirm',
        kind: 'accept_view',
        approval: 'confirm',
        rationale: 'accept view requires confirmation',
        viewId: 'view_missing_for_confirm',
      }, {
        id: 'act_retry_review',
        kind: 'start_review',
        approval: 'automatic',
        rationale: 'retry should be idempotent after interruption',
        queue: 'unmarked',
      }],
    },
  });
  const ids = actionIdsByModelKey();

  const old = '2026-06-01T00:00:00.000Z';
  db.prepare(`
    UPDATE agent_actions
    SET status = 'running', updated_at = ?, execution_started_at = ?
    WHERE id IN (?, ?)
  `).run(old, old, ids.act_plan_view_running, ids.act_refine_view_running);
  db.prepare(`
    INSERT INTO action_effects
      (id, action_id, effect_kind, status, idempotency_key, input_json, result_json, created_at, updated_at, completed_at)
    VALUES
      ('effect_plan_succeeded', ?, 'view_plan_create', 'succeeded', 'act_plan_view_running:view_plan_create', '{}', '{"viewIds":["view_eval"]}', ?, ?, ?),
      ('effect_refine_failed', ?, 'view_refinement_create', 'failed', 'act_refine_view_running:view_refinement_create', '{}', NULL, ?, ?, NULL)
  `).run(ids.act_plan_view_running, old, old, old, ids.act_refine_view_running, old, old);
}

function recoveryClassifiesActions(): EvalResult {
  const summary = recoverInterruptedAgentActions(db, {
    staleAfterMs: 60_000,
    now: new Date('2026-06-01T00:10:00.000Z'),
  });
  const ids = actionIdsByModelKey();
  const states = [
    'act_plan_view_running',
    'act_refine_view_running',
    'act_scan_confirm',
    'act_review_auto',
    'act_annotation_confirm',
    'act_accept_confirm',
    'act_retry_review',
  ].map(key => `${key}:${getAgentAction(db, ids[key]).status}`);
  return result(
    'Startup reconciliation',
    'succeeded effects become succeeded, failed/stale work becomes retryable, confirm actions remain proposed',
    `${JSON.stringify(summary)} ${states.join(', ')}`,
    summary.expectedProposed === 3
      && summary.buggedProposed === 2
      && summary.staleRunning === 2
      && getAgentAction(db, ids.act_plan_view_running).status === 'succeeded'
      && getAgentAction(db, ids.act_refine_view_running).status === 'failed'
      && getAgentAction(db, ids.act_scan_confirm).status === 'proposed'
      && getAgentAction(db, ids.act_annotation_confirm).status === 'proposed'
      && getAgentAction(db, ids.act_accept_confirm).status === 'proposed',
  );
}

async function retryFailedAutomaticAction(): Promise<EvalResult> {
  const ids = actionIdsByModelKey();
  const before = getAgentAction(db, ids.act_retry_review);
  const retried = await retryAgentAction(db, ids.act_retry_review);
  return result(
    'Retry failed automatic action',
    'failed automatic action is re-run safely and reaches a terminal state',
    `before=${before.status}; after=${retried.status}; kind=${retried.kind}`,
    before.status === 'failed'
      && retried.kind === 'start_review'
      && (retried.status === 'succeeded' || retried.status === 'failed'),
  );
}

function uiLabelsAreDistinct(): EvalResult {
  const js = fs.readFileSync('web-ui/conversation.js', 'utf8');
  return result(
    'UI action labels',
    'confirmation, interrupted, failed, and retry controls are distinct in the conversation UI',
    [
      js.includes('Waiting for your confirmation'),
      js.includes('Interrupted or failed'),
      js.includes('data-agent-retry'),
      js.includes('/retry'),
    ].join(','),
    js.includes('Waiting for your confirmation')
      && js.includes('Interrupted or failed')
      && js.includes('data-agent-retry')
      && js.includes('/retry'),
  );
}

function recoveryRecordsArePersisted(): EvalResult {
  const count = (db.prepare('SELECT COUNT(*) AS count FROM agent_action_recovery_events').get() as { count: number }).count;
  const reasons = (db.prepare('SELECT reason FROM agent_action_recovery_events ORDER BY reason').all() as Array<{ reason: string }>).map(row => row.reason);
  return result(
    'Recovery event audit',
    'every recovered action writes an agent_action_recovery_events record',
    `count=${count}; reasons=${reasons.join(',')}`,
    count >= 4 && reasons.includes('effect_succeeded') && reasons.includes('effect_failed') && reasons.includes('automatic_proposed_recovered'),
  );
}

function resourceIds(): string[] {
  return (db.prepare('SELECT id FROM resources ORDER BY id').all() as Array<{ id: string }>).map(row => row.id);
}

function actionIdsByModelKey(): Record<string, string> {
  const rows = db.prepare('SELECT model_action_key, id FROM agent_actions').all() as Array<{ model_action_key: string; id: string }>;
  return Object.fromEntries(rows.map(row => [row.model_action_key, row.id]));
}

function result(caseName: string, expected: string, actual: string, pass: boolean): EvalResult {
  return { caseName, expected, actual, pass };
}
