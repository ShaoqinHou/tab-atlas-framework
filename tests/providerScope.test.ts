import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ScopedProviderRegistry, type ProviderFactoryConfig } from '../src/llm/providerScope.js';
import type { LlmProvider } from '../src/llm/types.js';

class FakeProvider implements LlmProvider {
  constructor(readonly threadId: string) {}

  async complete() {
    return {
      text: '{}',
      usage: { quotaTurns: 1 },
    };
  }
}

function registryWithFakeProviders(maxTurnsPerThread = 20) {
  const db = openDatabase(':memory:');
  const factoryCalls: ProviderFactoryConfig[] = [];
  let providerCount = 0;
  const registry = new ScopedProviderRegistry(db, {
    maxTurnsPerThread,
    providerFactory: config => {
      factoryCalls.push(config);
      providerCount += 1;
      return new FakeProvider(`thread_${providerCount}`);
    },
  });
  return { db, registry, factoryCalls };
}

describe('scoped Codex provider registry', () => {
  it('separates provider rows and threads by role for the same logical scope', async () => {
    const { db, registry, factoryCalls } = registryWithFakeProviders();

    const conversation = registry.getProvider({ role: 'conversation_planner', scopeKey: 'thread_123' });
    const semantic = registry.getProvider({ role: 'semantic_planner', scopeKey: 'thread_123' });
    await conversation.complete('conversation');
    await semantic.complete('semantic');

    expect(conversation).not.toBe(semantic);
    expect(factoryCalls.map(call => call.role)).toEqual(['conversation_planner', 'semantic_planner']);
    const rows = db.prepare(`
      SELECT role, scope_key, model, reasoning_effort, generation, thread_id, turn_count
      FROM codex_provider_threads
      ORDER BY role
    `).all() as Array<{ role: string; scope_key: string; model: string; reasoning_effort: string; generation: number; thread_id: string; turn_count: number }>;
    expect(rows).toEqual([
      { role: 'conversation_planner', scope_key: 'thread_123', model: 'gpt-5.5', reasoning_effort: 'medium', generation: 1, thread_id: 'thread_1', turn_count: 1 },
      { role: 'semantic_planner', scope_key: 'thread_123', model: 'gpt-5.5', reasoning_effort: 'medium', generation: 1, thread_id: 'thread_2', turn_count: 1 },
    ]);
  });

  it('does not reuse provider rows across reasoning effort changes', async () => {
    const { db, registry } = registryWithFakeProviders();

    const medium = registry.getProvider({ role: 'conversation_planner', scopeKey: 'thread_abc', reasoningEffort: 'medium' });
    const high = registry.getProvider({ role: 'conversation_planner', scopeKey: 'thread_abc', reasoningEffort: 'high' });
    await medium.complete('medium');
    await high.complete('high');

    expect(high).not.toBe(medium);
    const rows = db.prepare(`
      SELECT reasoning_effort, generation, thread_id
      FROM codex_provider_threads
      WHERE role = 'conversation_planner' AND scope_key = 'thread_abc'
      ORDER BY generation
    `).all() as Array<{ reasoning_effort: string; generation: number; thread_id: string }>;
    expect(rows).toEqual([
      { reasoning_effort: 'medium', generation: 1, thread_id: 'thread_1' },
      { reasoning_effort: 'high', generation: 2, thread_id: 'thread_2' },
    ]);
  });

  it('reuses a scoped provider until the configured turn limit, then rotates generation', async () => {
    const { db, registry } = registryWithFakeProviders(1);

    const first = registry.getProvider({ role: 'resource_scan', scopeKey: 'job_1' });
    await first.complete('scan one');
    const second = registry.getProvider({ role: 'resource_scan', scopeKey: 'job_1' });
    await second.complete('scan two');

    expect(second).not.toBe(first);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    const rows = db.prepare(`
      SELECT role, scope_key, generation, thread_id, turn_count
      FROM codex_provider_threads
      ORDER BY generation
    `).all() as Array<{ role: string; scope_key: string; generation: number; thread_id: string; turn_count: number }>;
    expect(rows).toEqual([
      { role: 'resource_scan', scope_key: 'job_1', generation: 1, thread_id: 'thread_1', turn_count: 1 },
      { role: 'resource_scan', scope_key: 'job_1', generation: 2, thread_id: 'thread_2', turn_count: 1 },
    ]);
  });

  it('allocates a fresh generation for non-reused one-shot providers', () => {
    const { db, registry } = registryWithFakeProviders();

    const first = registry.getProvider({ role: 'one_shot', scopeKey: 'manual', reuseThread: false });
    const second = registry.getProvider({ role: 'one_shot', scopeKey: 'manual', reuseThread: false });

    expect(first).not.toBe(second);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    const generations = db.prepare(`
      SELECT generation
      FROM codex_provider_threads
      WHERE role = 'one_shot' AND scope_key = 'manual'
      ORDER BY generation
    `).all() as Array<{ generation: number }>;
    expect(generations.map(row => row.generation)).toEqual([1, 2]);
  });
});
