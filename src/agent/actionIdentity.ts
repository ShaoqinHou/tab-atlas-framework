import crypto from 'node:crypto';
import type { AgentAction, AgentTurnPlan } from './actionProtocol.js';

export interface MaterializedAgentAction {
  action: AgentAction;
  modelActionKey: string;
  actionOrdinal: number;
  idempotencyKey: string;
}

export interface MaterializedAgentTurnPlan {
  plan: AgentTurnPlan;
  actions: MaterializedAgentAction[];
  sourceKey: string;
}

export function materializeAgentTurnPlan(input: {
  threadId: string;
  assistantMessageId?: string;
  plan: AgentTurnPlan;
}): MaterializedAgentTurnPlan {
  const sourceKey = input.assistantMessageId ?? fallbackSourceKey(input.threadId, input.plan);
  const actions = input.plan.actions.map((action, actionOrdinal) => {
    const modelActionKey = action.id;
    const id = materializedActionId(sourceKey, actionOrdinal, modelActionKey);
    return {
      action: { ...action, id },
      modelActionKey,
      actionOrdinal,
      idempotencyKey: id,
    };
  });
  return {
    sourceKey,
    actions,
    plan: {
      ...input.plan,
      actions: actions.map(action => action.action),
    },
  };
}

export function materializedActionId(sourceKey: string, actionOrdinal: number, modelActionKey: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${sourceKey}\0${actionOrdinal}\0${modelActionKey}`)
    .digest('hex')
    .slice(0, 24);
  return `action_${digest}`;
}

function fallbackSourceKey(threadId: string, plan: AgentTurnPlan): string {
  const digest = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 24);
  return `thread:${threadId}:plan:${digest}`;
}
