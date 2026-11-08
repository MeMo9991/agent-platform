import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStage5Action } from '../src/authorization/stage5-policy.js';

test('stage five risk cannot be reduced by model or stale approval', () => {
  const repository = { repoKey: 'repo', provider: 'github' as const, hostUrl: 'https://github.com',
    projectRef: 'team/repo', targetBranch: 'main', requiredChecks: [], credentialsRef: 'env:TOKEN', localChecks: [] };
  const mandate = { sourceEventId: 'event', repoKey: 'repo', goal: 'Task',
    allowedActions: ['investigate', 'edit', 'open_pr', 'merge'] as ('investigate' | 'edit' | 'open_pr' | 'merge')[],
    maxAutoRisk: 'high' as const, policyVersion: 'v1',
    authority: { kind: 'human_approval' as const, approvalRef: 'approval' } };
  const input = { mandate, repository, action: 'open_pr' as const, targetBranch: 'main',
    sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), changedPaths: ['src/feature.ts'], approvalValid: false };
  assert.equal(evaluateStage5Action(input).kind, 'needs_approval');
  assert.equal(evaluateStage5Action({ ...input, approvalValid: true }).kind, 'allow');
  assert.equal(evaluateStage5Action({ ...input, targetBranch: 'other', approvalValid: true }).kind, 'deny');
  assert.equal(evaluateStage5Action({ ...input, changedPaths: ['.github/workflows/ci.yml'],
    modelRisk: 'low', approvalValid: true }).risk, 'high');
  assert.equal(evaluateStage5Action({ ...input, modelRisk: 'unknown', approvalValid: true }).kind, 'deny');
  assert.equal(evaluateStage5Action({ ...input, mandate: { ...mandate, maxAutoRisk: 'low' },
    approvalValid: true }).kind, 'needs_scope');
});
