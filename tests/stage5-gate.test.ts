import test from 'node:test';
import assert from 'node:assert/strict';
import { checksReady } from '../src/repository-ci/gate.js';
import type { z } from 'zod';
import type { changeSnapshot } from '../src/repository-ci/model.js';

test('CI gate rejects missing, duplicate, stale and pending required checks', () => {
  const sourceSha = 'a'.repeat(40);
  const targetSha = 'b'.repeat(40);
  const snapshot: z.infer<typeof changeSnapshot> = { change: { provider: 'github', repoKey: 'repo', id: '1',
    sourceSha, targetSha }, state: 'open', sourceSha, targetSha, gate: 'ready', observedAt: new Date().toISOString(),
    checks: [{ repoKey: 'repo', commitSha: sourceSha, name: 'test', status: 'completed', conclusion: 'success' }] };
  assert.equal(checksReady(snapshot, ['test']), true);
  assert.equal(checksReady(snapshot, []), false);
  assert.equal(checksReady(snapshot, ['missing']), false);
  assert.equal(checksReady({ ...snapshot, checks: [...snapshot.checks, ...snapshot.checks] }, ['test']), false);
  assert.equal(checksReady({ ...snapshot, targetSha: 'c'.repeat(40) }, ['test']), false);
  assert.equal(checksReady({ ...snapshot, checks: [{ ...snapshot.checks[0]!, status: 'pending' }] }, ['test']), false);
});
