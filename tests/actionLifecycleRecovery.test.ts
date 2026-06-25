import { describe, expect, it } from 'vitest';
import { createConversationThread, getAgentAction, persistAgentTurnPlan, recoverInterruptedAgentActions } from '../src/agent/conversationService.js';
import { openDatabase } from '../src/db/index.js';

describe('agent action lifecycle recovery', () => {
  it('leaves confirm actions proposed and recovers stale automatic/running actions', () => {
    const db = openDatabase(':memory:');
    try {
      const thread = createConversationThread(db, 'recovery test');
      const old = '2026-06-01T00:00:00.000Z';
      persistAgentTurnPlan(db, {
        threadId: thread.id,
        plan: {
          reply: 'planned actions',
          questions: [],
          assumptions: [],
          actions: [{
            id: 'act_confirm_scan',
            kind: 'scan_resources',
            approval: 'confirm',
            rationale: 'needs human approval',
            resourceIds: ['res_1'],
            limit: 10,
            force: false,
          }, {
            id: 'act_auto_review',
            kind: 'start_review',
            approval: 'automatic',
            rationale: 'should have executed automatically',
            queue: 'unmarked',
          }, {
            id: 'act_running_success',
            kind: 'start_review',
            approval: 'automatic',
            rationale: 'effect completed before interruption',
            queue: 'unmarked',
          }, {
            id: 'act_running_interrupted',
            kind: 'start_review',
            approval: 'automatic',
            rationale: 'stale running action',
            queue: 'unmarked',
          }],
        },
      });
      const ids = actionIdsByModelKey(db);

      db.prepare(`
        UPDATE agent_actions
        SET status = 'running', updated_at = ?, execution_started_at = ?
        WHERE id IN (?, ?)
      `).run(old, old, ids.act_running_success, ids.act_running_interrupted);
      db.prepare(`
        INSERT INTO action_effects
          (id, action_id, effect_kind, status, idempotency_key, input_json, result_json, created_at, updated_at, completed_at)
        VALUES
          ('effect_success', ?, 'scan_job_create', 'succeeded', 'act_running_success:scan_job_create', '{}', '{"ok":true}', ?, ?, ?)
      `).run(ids.act_running_success, old, old, old);

      const result = recoverInterruptedAgentActions(db, {
        staleAfterMs: 60_000,
        now: new Date('2026-06-01T00:10:00.000Z'),
      });

      expect(result).toMatchObject({
        expectedProposed: 1,
        buggedProposed: 1,
        staleRunning: 2,
        recovered: 3,
      });
      expect(getAgentAction(db, ids.act_confirm_scan).status).toBe('proposed');
      expect(getAgentAction(db, ids.act_auto_review)).toMatchObject({
        status: 'failed',
        error: 'Automatic action did not begin execution; retry is available.',
      });
      expect(getAgentAction(db, ids.act_running_success)).toMatchObject({
        status: 'succeeded',
        result: { ok: true },
      });
      expect(getAgentAction(db, ids.act_running_interrupted)).toMatchObject({
        status: 'failed',
        error: 'Interrupted while running; retry is available.',
      });
      expect((db.prepare('SELECT COUNT(*) AS count FROM agent_action_recovery_events').get() as { count: number }).count).toBe(3);
    } finally {
      db.close();
    }
  });

  it('recovers recently running actions immediately during startup recovery', () => {
    const db = openDatabase(':memory:');
    try {
      const thread = createConversationThread(db, 'immediate recovery test');
      persistAgentTurnPlan(db, {
        threadId: thread.id,
        plan: {
          reply: 'planned action',
          questions: [],
          assumptions: [],
          actions: [{
            id: 'act_recent_running',
            kind: 'start_review',
            approval: 'automatic',
            rationale: 'recent interrupted action',
            queue: 'unmarked',
          }],
        },
      });
      const ids = actionIdsByModelKey(db);
      const recent = '2026-06-01T00:09:59.000Z';
      db.prepare(`
        UPDATE agent_actions
        SET status = 'running', updated_at = ?, execution_started_at = ?
        WHERE id = ?
      `).run(recent, recent, ids.act_recent_running);
      db.prepare(`
        INSERT INTO action_effects
          (id, action_id, effect_kind, status, idempotency_key, input_json, created_at, updated_at, started_at)
        VALUES ('effect_recent', ?, 'review_decision', 'running', 'act_recent_running:review_decision', '{}', ?, ?, ?)
      `).run(ids.act_recent_running, recent, recent, recent);

      const result = recoverInterruptedAgentActions(db, {
        staleAfterMs: 60_000,
        now: new Date('2026-06-01T00:10:00.000Z'),
        recoverAllRunning: true,
      });

      expect(result).toMatchObject({ recovered: 1, staleRunning: 1 });
      expect(getAgentAction(db, ids.act_recent_running)).toMatchObject({
        status: 'failed',
        error: 'Interrupted while running; retry is available.',
      });
      const effect = db.prepare('SELECT status, error FROM action_effects WHERE id = ?').get('effect_recent') as { status: string; error: string | null };
      expect(effect).toMatchObject({
        status: 'failed',
        error: 'Interrupted while running; retry is available.',
      });
    } finally {
      db.close();
    }
  });
});

function actionIdsByModelKey(db: ReturnType<typeof openDatabase>): Record<string, string> {
  const rows = db.prepare('SELECT model_action_key, id FROM agent_actions').all() as Array<{ model_action_key: string; id: string }>;
  return Object.fromEntries(rows.map(row => [row.model_action_key, row.id]));
}
