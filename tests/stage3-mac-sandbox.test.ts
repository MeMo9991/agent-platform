import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMacSandboxProfile, createMacQoderRuntime } from '../src/agent/worker/mac-sandbox.js';
import { createQoderRunner } from '../src/agent/worker/agents/qoder.js';

test('macOS sandbox limits read and write paths for each Run mode',
  { skip: process.platform !== 'darwin' }, async () => {
    const root = mkdtempSync('/private/tmp/agent-sandbox-');
    const home = join(root, 'home');
    const workspace = join(root, 'clone');
    const temporary = join(root, 'temporary');
    const qoder = join(home, '.qoder-cn');
    const link = join(home, '.local', 'bin');
    const outside = join(root, 'outside');
    for (const path of [home, workspace, temporary, qoder, link, outside]) mkdirSync(path, { recursive: true });
    const secret = join(outside, 'fake-secret');
    writeFileSync(secret, 'fake-only');
    const run = (profile: string, command: string, args: string[]) =>
      spawnSync('/usr/bin/sandbox-exec', ['-f', profile, command, ...args],
        { cwd: workspace, encoding: 'utf8' });
    try {
      for (const mode of ['read', 'write'] as const) {
        const { profile, digest } = await createMacSandboxProfile({ workspacePath: workspace,
          temporaryPath: temporary, qoderConfigPath: qoder, qoderLinkDirectory: link, homePath: home, mode });
        assert.match(digest, /^[a-f0-9]{64}$/);
        const path = join(root, `${mode}.sb`);
        writeFileSync(path, profile);
        assert.equal(run(path, '/bin/cat', [secret]).status, 1);
        assert.equal(run(path, '/usr/bin/touch', [join(outside, 'blocked')]).status, 1);
        assert.equal(run(path, '/usr/bin/touch', [join(temporary, 'allowed')]).status, 0);
        assert.equal(run(path, '/usr/bin/touch', [join(workspace, `${mode}.txt`)]).status,
          mode === 'write' ? 0 : 1);
      }
      const target = join(outside, 'target');
      writeFileSync(target, 'original');
      symlinkSync(target, join(workspace, 'link'));
      const profile = join(root, 'write.sb');
      assert.equal(run(profile, '/bin/sh', ['-c', 'echo changed > link']).status, 1);
      assert.equal(readFileSync(target, 'utf8'), 'original');
      assert.equal(run(profile, '/bin/ln', [target, join(workspace, 'hardlink')]).status, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test('trusted check reuses the Run sandbox and confirms timeout termination',
  { skip: process.platform !== 'darwin' }, async () => {
    const root = mkdtempSync('/private/tmp/agent-run-check-');
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    const qoder = join(bin, 'qoderclicn');
    const previousHome = process.env.HOME;
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, '.qoder-cn'));
    writeFileSync(qoder, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const cloneRoot = join(root, 'clones');
    const clone = join(cloneRoot, 'runcheck');
    const profileRoot = join(root, 'profiles');
    mkdirSync(clone, { recursive: true });
    execFileSync('git', ['init', '-q', clone]);
    process.env.HOME = home;
    try {
      const runtime = await createMacQoderRuntime({ cloneRoot, profileRoot, qoderPath: qoder });
      const proof = await runtime.boundary.attest({ runId: 'runcheck', repoKey: 'repo',
        workspacePath: clone, mode: 'read', mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'read',
          allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
          authority: { kind: 'trusted_rule', ruleRef: 'test' } } });
      assert.ok(proof);
      const launched = runtime.launcher.launch('qoderclicn', ['--version'], clone, proof);
      await new Promise<void>(resolve => launched.process.once('close', () => resolve()));
      assert.throws(() => runtime.boundary.runCheck!({ proof: { ...proof, configDigest: 'forged' },
        command: '/usr/bin/git', args: ['status'], cwd: clone, timeoutMs: 5000,
        signal: new AbortController().signal }), /verified isolation/);
      const check = runtime.boundary.runCheck!({ proof, command: '/usr/bin/git',
        args: ['status', '--short'], cwd: clone, timeoutMs: 5000, signal: new AbortController().signal });
      const passed = await check.completion;
      assert.equal(passed.result, 'passed');
      assert.equal(passed.terminationConfirmed, true);
      assert.equal(readFileSync(passed.logRef, 'utf8').trim(), '');
      const denied = runtime.boundary.runCheck!({ proof, command: '/usr/bin/touch',
        args: [join(root, 'outside')], cwd: clone, timeoutMs: 5000, signal: new AbortController().signal });
      assert.equal((await denied.completion).result, 'failed');
      assert.equal(existsSync(join(root, 'outside')), false);
      const slow = runtime.boundary.runCheck!({ proof, command: '/bin/sleep',
        args: ['30'], cwd: clone, timeoutMs: 100, signal: new AbortController().signal });
      assert.equal((await slow.terminate()).terminated, true);
      await runtime.boundary.release!(proof);
      assert.equal(readdirSync(profileRoot).filter(name => name.endsWith('.sb')).length, 0);
      const stale = await runtime.boundary.attest({ runId: 'runcheck', repoKey: 'repo',
        workspacePath: clone, mode: 'read', mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'read',
          allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
          authority: { kind: 'trusted_rule', ruleRef: 'test' } } });
      assert.ok(stale);
      const restarted = await createMacQoderRuntime({ cloneRoot, profileRoot, qoderPath: qoder });
      const next = await restarted.boundary.attest({ runId: 'runcheck', repoKey: 'repo',
        workspacePath: clone, mode: 'read', mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'read',
          allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
          authority: { kind: 'trusted_rule', ruleRef: 'test' } } });
      assert.ok(next);
      assert.equal(readdirSync(profileRoot).filter(name => name.endsWith('.sb')).length, 2);
      await restarted.boundary.release!(next);
      await runtime.boundary.release!(stale);
    } finally { process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
  });

test('sandboxed process leaves a durable Qoder result readable after Runner restart',
  { skip: process.platform !== 'darwin' }, async () => {
    const root = mkdtempSync('/private/tmp/agent-durable-run-');
    const previousHome = process.env.HOME;
    mkdirSync(join(root, 'home', '.qoder-cn'), { recursive: true });
    const cloneRoot = join(root, 'clones');
    const clone = join(cloneRoot, 'run-1');
    const bin = join(root, 'bin');
    mkdirSync(clone, { recursive: true });
    mkdirSync(bin);
    execFileSync('git', ['init', '-q', clone]);
    const cli = join(bin, 'qoderclicn');
    writeFileSync(cli, '#!/bin/sh\n' +
      "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"durable-session\"}'\n" +
      "printf '%s\\n' '{\"type\":\"assistant\",\"session_id\":\"durable-session\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Investigating\"}]}}'\n" +
      "printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":\"durable-session\",\"result\":\"Verified conclusion\",\"is_error\":false}'\n",
    { mode: 0o700 });
    process.env.HOME = join(root, 'home');
    try {
      const runtime = await createMacQoderRuntime({ cloneRoot, profileRoot: join(root, 'profiles'), qoderPath: cli });
      const mandate = { sourceEventId: 'event', repoKey: 'repo', goal: 'Investigate',
        allowedActions: ['investigate'] as Array<'investigate'>, maxAutoRisk: 'low' as const,
        policyVersion: 'p1', authority: { kind: 'trusted_rule' as const, ruleRef: 'test' } };
      const proof = await runtime.boundary.attest({ runId: 'run-1', repoKey: 'repo',
        workspacePath: clone, mode: 'read', mandate });
      assert.ok(proof);
      const logs = join(root, 'logs');
      const runner = createQoderRunner(runtime.launcher, logs);
      const started = await runner.start({ taskId: 'task', runId: 'run-1', stage: 'investigate',
        mandate, repoKey: 'repo', workspace: { repoKey: 'repo', path: clone, baseSha: 'a'.repeat(40) },
        input: { kind: 'task', runId: 'run-1', prompt: 'Inspect', sourceEventIds: ['event'] },
        skill: { content: 'Investigate safely', ref: { repoRef: 'repo', path: 'skills/investigate/SKILL.md',
          commitSha: 'a'.repeat(40), stage: 'investigate' } }, execution: proof, timeoutMs: 5000 });
      let finished = await runner.read(started.sessionId);
      for (let i = 0; i < 50 && finished.kind === 'running'; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        finished = await runner.read(started.sessionId);
      }
      assert.equal(finished.kind, 'finished');
      if (finished.kind !== 'finished') return;
      assert.equal(finished.exitCode, 0);
      assert.ok(finished.resultRef);
      const fresh = createQoderRunner(runtime.launcher, logs);
      assert.equal((await fresh.read(started.sessionId)).kind, 'unknown');
      assert.equal((await fresh.readDurable!('run-1', started.sessionId)).kind, 'finished');
      assert.equal(await fresh.resultSummary!('run-1', started.sessionId, finished.resultRef!), 'Verified conclusion');
      await runtime.boundary.release!(proof);
    } finally { process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
  });
