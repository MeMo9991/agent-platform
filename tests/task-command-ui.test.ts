import test from 'node:test';
import assert from 'node:assert/strict';
import { canInterruptTask } from '../web/src/shared/task-command-availability.ts';
import type { Detail } from '../web/src/shared/types.ts';

const detail = (state: string, records: Detail['records'] = [], runs: Detail['runs'] = []): Detail => ({
  task: { id: 'task-1', title: 'Task', scope: 'Task', repoKey: 'repo', state, iteration: 1,
    priority: 0, version: 1, updatedAt: '', mandate: { goal: 'Task', allowedActions: [],
      policyVersion: 'p1', authority: { kind: 'trusted_rule' } } },
  records, runs, events: [],
});

test('takeover is offered only when the server can accept interruption', () => {
  assert.equal(canInterruptTask(detail('ready_to_merge')), false);
  assert.equal(canInterruptTask(detail('investigating')), true);
  assert.equal(canInterruptTask(detail('investigating', [{ id: 'request', taskId: 'task-1', kind: 'approval_request', at: '', status: 'open' }])), false);
  assert.equal(canInterruptTask(detail('investigating', [], [{ id: 'run', stage: 'investigate', status: 'waiting_human', createdAt: '' }])), false);
  assert.equal(canInterruptTask(detail('investigating', [], [
    { id: 'old', stage: 'investigate', status: 'waiting_human', createdAt: '1' },
    { id: 'new', stage: 'investigate', status: 'running', createdAt: '2' },
  ])), true);
});
