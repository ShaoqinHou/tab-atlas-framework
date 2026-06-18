import type Database from 'better-sqlite3';
import {
  FeedbackIntentScope,
  buildFeedbackIntentScope,
  matchFeedbackScope,
  type FeedbackScopeMatch,
} from './intentScope.js';

export function saveFeedbackIntentContext(
  db: Database.Database,
  input: {
    feedbackId: string;
    mode?: 'view_revision' | 'intent' | 'global';
    sourceViewId?: string;
    sourceRevisionId?: string;
    sourceCommandText?: string;
    sourceGoal?: string;
    sourceRules?: string[];
  },
): FeedbackIntentScope {
  const scope = buildFeedbackIntentScope(input);
  db.prepare(`
    INSERT INTO membership_feedback_context
      (feedback_id, scope_mode, source_view_id, source_revision_id, source_command_text,
       source_goal, source_rules_json, intent_terms_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(feedback_id) DO UPDATE SET
      scope_mode = excluded.scope_mode,
      source_view_id = excluded.source_view_id,
      source_revision_id = excluded.source_revision_id,
      source_command_text = excluded.source_command_text,
      source_goal = excluded.source_goal,
      source_rules_json = excluded.source_rules_json,
      intent_terms_json = excluded.intent_terms_json
  `).run(
    input.feedbackId,
    scope.mode,
    scope.sourceViewId ?? null,
    scope.sourceRevisionId ?? null,
    scope.sourceCommandText,
    scope.sourceGoal,
    JSON.stringify(scope.sourceRules),
    JSON.stringify(scope.intentTerms),
    new Date().toISOString(),
  );
  return scope;
}

export function getFeedbackIntentContext(
  db: Database.Database,
  feedbackId: string,
): FeedbackIntentScope | null {
  const row = db.prepare(`
    SELECT scope_mode, source_view_id, source_revision_id, source_command_text,
           source_goal, source_rules_json, intent_terms_json
    FROM membership_feedback_context
    WHERE feedback_id = ?
  `).get(feedbackId) as {
    scope_mode: 'view_revision' | 'intent' | 'global';
    source_view_id: string | null;
    source_revision_id: string | null;
    source_command_text: string;
    source_goal: string;
    source_rules_json: string;
    intent_terms_json: string;
  } | undefined;
  if (!row) return null;
  return FeedbackIntentScope.parse({
    mode: row.scope_mode,
    sourceViewId: row.source_view_id ?? undefined,
    sourceRevisionId: row.source_revision_id ?? undefined,
    sourceCommandText: row.source_command_text,
    sourceGoal: row.source_goal,
    sourceRules: parseStringArray(row.source_rules_json),
    intentTerms: parseStringArray(row.intent_terms_json),
  });
}

export function evaluateFeedbackForIntent(
  db: Database.Database,
  feedbackId: string,
  current: { commandText: string; viewId?: string; revisionId?: string },
): FeedbackScopeMatch {
  const scope = getFeedbackIntentContext(db, feedbackId);
  if (!scope) return { applies: false, score: 0, reason: 'feedback has no intent context' };
  return matchFeedbackScope(scope, current);
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
