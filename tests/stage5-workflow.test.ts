import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAgentEvent } from '../src/agent/task/workflow.js';
import type { Task } from '../src/agent/task/model.js';
import type { Run } from '../src/agent/worker/model.js';

test('verify advances only with checks on its pinned SHA', () => {
  const at = new Date().toISOString();
  const sha = 'b'.repeat(40);
  const task: Task = { id: 'task', repoKey: 'repo', title: 'Task', scope: 'Task',
    mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Task',
      allowedActions: ['investigate', 'edit'], maxAutoRisk: 'low', policyVersion: 'p1',
      authority: { kind: 'human_approval', approvalRef: 'approval' } },
    state: 'verifying', iteration: 1, priority: 0, baseRef: 'a'.repeat(40), createdAt: at, updatedAt: at };
  const run: Run = { id: 'verify', taskId: task.id, iteration: 1, stage: 'verify',
    status: 'running', priority: 0, attempt: 1, commitSha: sha, createdAt: at };
  const check = { command: 'npm', args: ['test'], timeoutMs: 1000, startedAt: at, endedAt: at,
    result: 'passed' as const, exitCode: 0, logRef: '/tmp/check.log', terminationConfirmed: true };
  const result = { kind: 'result' as const, runId: run.id, status: 'succeeded' as const,
    exitCode: 0, resultRef: 'result', verification: { subjectSha: sha,
      postCheckVerified: true, checks: [check] } };
  assert.deepEqual(decideAgentEvent(task, run, result), { state: 'reviewing', queueStage: 'review' });
  const platformResult = { kind: 'result' as const, runId: run.id, status: 'succeeded' as const,
    exitCode: 0, verification: result.verification };
  assert.deepEqual(decideAgentEvent(task, run, platformResult), { state: 'reviewing', queueStage: 'review' });
  assert.deepEqual(decideAgentEvent(task, run, platformResult, false, 0, true, true, true),
    { state: 'verifying', queueStage: 'functional_verify' });
  assert.equal(decideAgentEvent(task, run, { ...result, verification: { ...result.verification,
    subjectSha: 'c'.repeat(40) } }).state, 'blocked');
  assert.equal(decideAgentEvent(task, run, { ...result, verification: { ...result.verification,
    checks: [{ ...check, result: 'timeout', exitCode: null }] } }).state, 'blocked');
  assert.deepEqual(decideAgentEvent(task, run, { ...result, verification: { ...result.verification,
    checks: [{ ...check, result: 'failed', exitCode: 1 }] } }),
  { state: 'blocked', reason: 'Fixed-SHA check npm failed (exit 1); inspect its check log' });
});

test('functional verification gates review and reports mismatches or unavailable local checks', () => {
  const at = new Date().toISOString();
  const sha = 'b'.repeat(40);
  const task: Task = { id: 'task', repoKey: 'repo', title: 'Task', scope: 'Task',
    mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Task',
      allowedActions: ['investigate', 'edit'], maxAutoRisk: 'low', policyVersion: 'p1',
      authority: { kind: 'human_approval', approvalRef: 'approval' } },
    state: 'verifying', iteration: 1, priority: 0, baseRef: sha, createdAt: at, updatedAt: at };
  const run: Run = { id: 'functional', taskId: task.id, iteration: 1, stage: 'functional_verify',
    status: 'running', priority: 0, attempt: 0, commitSha: sha, createdAt: at };
  const result = (verdict: 'pass' | 'fail' | 'unverifiable') => ({ kind: 'result' as const,
    runId: run.id, status: 'succeeded' as const, exitCode: 0, resultRef: 'result',
    functionalVerification: { subjectSha: sha, verdict, reason: 'Local observation' } });
  assert.deepEqual(decideAgentEvent(task, run, result('pass')),
    { state: 'reviewing', queueStage: 'review' });
  assert.deepEqual(decideAgentEvent(task, run, result('fail')),
    { state: 'developing', queueStage: 'develop', reason: 'Local functional verification failed' });
  assert.deepEqual(decideAgentEvent(task, run, result('unverifiable')),
    { state: 'waiting_human', reason: 'Local functional verification could not be completed' });
  assert.equal(decideAgentEvent(task, run, { ...result('pass'), functionalVerification: undefined }).state, 'blocked');
});

test('review blocks after two automatic repair rounds', () => {
  const at = new Date().toISOString();
  const sha = 'b'.repeat(40);
  const task: Task = { id: 'task', repoKey: 'repo', title: 'Task', scope: 'Task',
    mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Task',
      allowedActions: ['investigate', 'edit'], maxAutoRisk: 'low', policyVersion: 'p1',
      authority: { kind: 'human_approval', approvalRef: 'approval' } },
    state: 'reviewing', iteration: 1, priority: 0, baseRef: 'a'.repeat(40), createdAt: at, updatedAt: at };
  const run: Run = { id: 'review', taskId: task.id, iteration: 1, stage: 'review',
    status: 'running', priority: 0, attempt: 1, commitSha: sha, createdAt: at };
  const event = { kind: 'result' as const, runId: run.id, status: 'succeeded' as const,
    exitCode: 0, resultRef: 'result', review: { subjectSha: sha, verdict: 'block' as const,
      findings: [{ file: 'src/code.ts', severity: 'high', evidence: 'Specific regression',
        impact: 'Breaks the task', action: 'Fix', verificationMethod: 'Run regression test' }] } };
  assert.deepEqual(decideAgentEvent(task, run, event, false, 0).queueStage, 'develop');
  assert.deepEqual(decideAgentEvent(task, run, event, false, 1).queueStage, 'develop');
  assert.equal(decideAgentEvent(task, run, event, false, 2).state, 'waiting_human');
  assert.equal(decideAgentEvent(task, run, { ...event, review: { ...event.review,
    subjectSha: 'c'.repeat(40) } }).state, 'blocked');
  assert.equal(decideAgentEvent(task, run, { ...event, review: { ...event.review,
    verdict: 'pass' } }, false, 0).queueStage, 'develop');
});
