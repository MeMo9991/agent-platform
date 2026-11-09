import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../src/storage/sqlite/store.js';

test('external effect intent persists before a matching receipt and rejects key reuse', () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  const sourceSha = 'a'.repeat(40);
  const targetSha = 'b'.repeat(40);
  try {
    store.saveTask({ id: 'task', repoKey: 'repo', title: 'Task', scope: 'Task', state: 'ready_to_merge',
      iteration: 1, priority: 0, createdAt: at, updatedAt: at, mandate: {
        sourceEventId: 'event', repoKey: 'repo', goal: 'Task', allowedActions: ['investigate'],
        maxAutoRisk: 'low', policyVersion: 'v1', authority: { kind: 'trusted_rule', ruleRef: 'rule' } } });
    const current = store.getTask('task')!;
    const authorized = { ...current, mandate: { ...current.mandate, allowedActions: ['investigate', 'open_pr', 'merge'],
      maxAutoRisk: 'high', authority: { kind: 'human_approval', approvalRef: 'fixture' } } };
    store.db.prepare('UPDATE task SET mandate=?,payload_json=? WHERE id=?')
      .run(JSON.stringify(authorized.mandate), JSON.stringify(authorized), 'task');
    const intent = { id: 'effect', taskId: 'task', kind: 'effect' as const, action: 'open_pr' as const,
      idempotencyKey: 'open-task', status: 'pending' as const, subjectSha: sourceSha, at,
      request: { repoKey: 'repo', sourceBranch: 'agent-platform/task', targetBranch: 'main',
        sourceSha, targetSha, policyVersion: 'v1' } };
    assert.deepEqual(store.saveEffectIntent(intent), intent);
    assert.deepEqual(store.saveEffectIntent({ ...intent, id: 'retry' }), intent);
    assert.throws(() => store.saveEffectIntent({ ...intent, id: 'other',
      request: { ...intent.request, targetSha: 'c'.repeat(40) } }), /conflicts/);
    assert.throws(() => store.settleEffect('effect', 'done', { changeId: '1',
      observedSourceSha: 'c'.repeat(40), observedTargetSha: targetSha, merged: false }), /does not match/);
    store.settleEffect('effect', 'done', { changeId: '1', observedSourceSha: sourceSha,
      observedTargetSha: targetSha, merged: false });
    assert.equal(store.getRecord('effect')?.kind === 'effect' && store.getRecord('effect')?.status, 'done');
  } finally { store.close(); }
});
