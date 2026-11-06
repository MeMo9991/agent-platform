import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerLoop } from '../src/bootstrap/worker-loop.js';
import { acquireInstanceLock } from '../src/bootstrap/instance-lock.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('second instance cannot acquire the database lock before recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-lock-'));
  const database = join(directory, 'state.sqlite3');
  symlinkSync(directory, join(directory, 'alias'));
  try {
    const first = await acquireInstanceLock(database, () => { throw new Error('First lock was lost'); });
    try {
      await assert.rejects(acquireInstanceLock(join(directory, 'alias', 'state.sqlite3'), () => {}),
        /Instance lock unavailable/);
    } finally { await first.release(); }
    const restarted = await acquireInstanceLock(database, () => { throw new Error('Restarted lock was lost'); });
    await restarted.release();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a dangling database symlink cannot acquire an alias lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-dangling-lock-'));
  const database = join(directory, 'target.sqlite3');
  const alias = join(directory, 'alias.sqlite3');
  symlinkSync(database, alias);
  try {
    const first = await acquireInstanceLock(database, () => { throw new Error('First lock was lost'); });
    try {
      await assert.rejects(acquireInstanceLock(alias, () => {}), /dangling symbolic link/);
      assert.equal(existsSync(`${alias}.lock`), false);
    } finally { await first.release(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('instance lock rejects a database directory accessible to another account', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-open-lock-'));
  try {
    chmodSync(directory, 0o777);
    await assert.rejects(acquireInstanceLock(join(directory, 'state.sqlite3'), () => {}),
      /owned by the service account and accessible only to it/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('instance lock rejects a private directory under a replaceable parent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-open-parent-'));
  const state = join(directory, 'state');
  try {
    mkdirSync(state, { mode: 0o700 });
    chmodSync(directory, 0o777);
    await assert.rejects(acquireInstanceLock(join(state, 'state.sqlite3'), () => {}),
      /parent directory can be replaced/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('instance lock rejects a directory with an ACL grant hidden from mode bits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-acl-lock-'));
  try {
    execFileSync('/bin/chmod', ['+a', 'everyone allow read,write', directory]);
    await assert.rejects(acquireInstanceLock(join(directory, 'state.sqlite3'), () => {}),
      /owned by the service account and accessible only to it/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('shutdown waits for an active Worker tick and poll before database close', async () => {
  let releaseTick!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { releaseTick = resolve; });
  const calls: string[] = [];
  const loop = startWorkerLoop({ async tick() { calls.push('tick'); started(); await pending; },
    async poll() { calls.push('poll'); } }, 60_000, error => { throw error; });
  loop.runOnce();
  await entered;
  let stopped = false;
  const stopping = loop.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  releaseTick();
  await stopping;
  loop.runOnce();
  assert.deepEqual(calls, ['tick', 'poll']);
});
