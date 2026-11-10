import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
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
        if (mode === 'write') {
          assert.notEqual(run(path, '/usr/bin/touch', [join(qoder, 'blocked')]).status, 0);
          assert.equal(existsSync(join(qoder, 'blocked')), false);
        }
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

test('write sandbox on the current account cannot read platform credentials or write outside its Run',
  { skip: process.platform !== 'darwin' }, async () => {
    const home = homedir();
    const qoderConfig = resolve(home, '.qoder-cn');
    const qoderLink = dirname(resolve(home, '.local/bin/qoderclicn'));
    if (!existsSync(qoderConfig) || !existsSync(qoderLink)) return;
    const root = mkdtempSync('/private/tmp/agent-write-probe-');
    const workspace = join(root, 'workspace');
    const temporary = join(root, 'temporary');
    const outside = join(root, 'outside');
    for (const path of [workspace, temporary, outside]) mkdirSync(path);
    const profilePath = join(root, 'write.sb');
    const run = (command: string, args: string[]) => spawnSync('/usr/bin/sandbox-exec',
      ['-f', profilePath, command, ...args], { cwd: workspace, stdio: 'ignore' }).status;
    try {
      const { profile } = await createMacSandboxProfile({ workspacePath: workspace,
        temporaryPath: temporary, qoderConfigPath: qoderConfig,
        qoderLinkDirectory: qoderLink, homePath: home, mode: 'write' });
      writeFileSync(profilePath, profile);
      const localToken = resolve(home, '.config/agent-platform/local-api.token');
      if (existsSync(localToken)) assert.notEqual(run('/bin/cat', [localToken]), 0);
      const qoderSettings = resolve(qoderConfig, 'settings.json');
      if (existsSync(qoderSettings)) {
        assert.notEqual(run('/bin/cat', [qoderSettings]), 0);
        symlinkSync(qoderSettings, join(workspace, 'linked-settings'));
        assert.notEqual(run('/bin/cat', [join(workspace, 'linked-settings')]), 0);
      }
      assert.notEqual(run('/usr/bin/touch', [join(outside, 'denied')]), 0);
      assert.equal(existsSync(join(outside, 'denied')), false);
      assert.equal(run('/usr/bin/touch', [join(workspace, 'allowed')]), 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test('write attestation binds human edit scope and launches Qoder with only its dedicated credential',
  { skip: process.platform !== 'darwin' }, async () => {
    const root = mkdtempSync('/private/tmp/agent-write-run-');
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    const qoder = join(bin, 'qoderclicn');
    const cloneRoot = join(root, 'clones');
    const clone = join(cloneRoot, 'write-run');
    const outside = join(root, 'outside');
    const previousHome = process.env.HOME;
    const previousPat = process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
    const previousGithub = process.env.AGENT_PLATFORM_GITHUB_TOKEN;
    for (const path of [bin, join(home, '.qoder-cn'), join(home, '.config', 'agent-platform'), clone, outside])
      mkdirSync(path, { recursive: true });
    execFileSync('git', ['init', '-q', clone]);
    writeFileSync(join(clone, 'file.txt'), 'before\n');
    execFileSync('git', ['-C', clone, 'add', 'file.txt']);
    execFileSync('git', ['-C', clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      'commit', '-qm', 'base']);
    writeFileSync(join(home, '.qoder-cn', 'settings.json'), '{}');
    writeFileSync(join(home, '.config', 'agent-platform', 'local-api.token'), 'fixture-local-only');
    writeFileSync(qoder, `#!/bin/sh
[ "$1" = --config-dir ] || exit 29
[ -f "$2/settings.json" ] || exit 30
/usr/bin/grep -F "$PWD" "$2/settings.json" >/dev/null || exit 31
[ "$HOME" != "${home}" ] || exit 20
[ "$QODERCN_PERSONAL_ACCESS_TOKEN" = fixture-only ] || exit 21
[ -z "$AGENT_PLATFORM_GITHUB_TOKEN" ] || exit 22
/bin/cat "${home}/.qoder-cn/settings.json" >/dev/null 2>&1 && exit 23
/bin/cat "${home}/.config/agent-platform/local-api.token" >/dev/null 2>&1 && exit 26
/usr/bin/touch "${outside}/escape" 2>/dev/null && exit 24
printf 'after\n' > "$PWD/file.txt" || exit 25
/usr/bin/git -C "$PWD" add file.txt || exit 27
/usr/bin/git -C "$PWD" -c user.name=Fixture -c user.email=fixture@example.test commit -qm fix || exit 28
`, { mode: 0o700 });
    process.env.HOME = home;
    process.env.AGENT_PLATFORM_GITHUB_TOKEN = 'fixture-github-only';
    try {
      const runtime = await createMacQoderRuntime({ cloneRoot, profileRoot: join(root, 'profiles'),
        qoderPath: qoder, writeEnabled: true });
      const mandate = { sourceEventId: 'event', repoKey: 'repo', goal: 'Edit',
        allowedActions: ['investigate', 'edit'] as Array<'investigate' | 'edit'>,
        maxAutoRisk: 'high' as const, policyVersion: 'p1',
        authority: { kind: 'human_approval' as const, approvalRef: 'approved' } };
      assert.equal(await runtime.boundary.attest({ runId: 'write-run', repoKey: 'repo',
        workspacePath: clone, mode: 'write', mandate }), undefined);
      process.env.QODERCN_PERSONAL_ACCESS_TOKEN = 'fixture-only';
      const disabled = await createMacQoderRuntime({ cloneRoot, profileRoot: join(root, 'profiles'), qoderPath: qoder });
      assert.equal(await disabled.boundary.attest({ runId: 'write-run', repoKey: 'repo',
        workspacePath: clone, mode: 'write', mandate }), undefined);
      assert.equal(await runtime.boundary.attest({ runId: 'write-run', repoKey: 'repo',
        workspacePath: clone, mode: 'write', mandate: { ...mandate, allowedActions: ['investigate'] } }), undefined);
      assert.equal(await runtime.boundary.attest({ runId: 'write-run', repoKey: 'repo',
        workspacePath: clone, mode: 'write', mandate: { ...mandate,
          authority: { kind: 'trusted_rule', ruleRef: 'fixture' }, maxAutoRisk: 'low' } }), undefined);
      const proof = await runtime.boundary.attest({ runId: 'write-run', repoKey: 'repo',
        workspacePath: clone, mode: 'write', mandate });
      assert.ok(proof);
      const launched = runtime.launcher.launch('qoderclicn', [], clone, proof);
      await new Promise<void>(resolve => launched.process.once('close', () => resolve()));
      assert.equal(launched.process.exitCode, 0);
      assert.equal(readFileSync(join(clone, 'file.txt'), 'utf8'), 'after\n');
      assert.equal(execFileSync('git', ['-C', clone, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(), 'fix');
      assert.equal(existsSync(join(outside, 'escape')), false);
      const check = runtime.boundary.runCheck!({ proof, command: '/bin/sh',
        args: ['-c', '[ -z "$QODERCN_PERSONAL_ACCESS_TOKEN" ] && [ -z "$AGENT_PLATFORM_GITHUB_TOKEN" ]'],
        cwd: clone, timeoutMs: 5000, signal: new AbortController().signal });
      assert.equal((await check.completion).result, 'passed');
      await runtime.boundary.release!(proof);
      const autoProof = await runtime.boundary.attest({ runId: 'write-run', repoKey: 'repo',
        workspacePath: clone, mode: 'write', mandate: { ...mandate,
          allowedActions: ['investigate', 'edit', 'open_pr'],
          authority: { kind: 'auto_pr', ruleRef: 'configured-rule' } } });
      assert.ok(autoProof);
      await runtime.boundary.release!(autoProof);
    } finally {
      process.env.HOME = previousHome;
      if (previousPat === undefined) delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
      else process.env.QODERCN_PERSONAL_ACCESS_TOKEN = previousPat;
      if (previousGithub === undefined) delete process.env.AGENT_PLATFORM_GITHUB_TOKEN;
      else process.env.AGENT_PLATFORM_GITHUB_TOKEN = previousGithub;
      rmSync(root, { recursive: true, force: true });
    }
  });

test('trusted check reuses the Run sandbox and confirms timeout termination',
  { skip: process.platform !== 'darwin' }, async () => {
    const root = mkdtempSync('/private/tmp/agent-run-check-');
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    const qoder = join(bin, 'qoderclicn');
    const previousHome = process.env.HOME;
    const previousPat = process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, '.qoder-cn'));
    writeFileSync(join(home, '.qoder-cn', 'sensitive'), 'fixture-only');
    writeFileSync(join(home, '.qoder-cn', 'settings.json'), JSON.stringify({ vpcInstanceName: 'acme' }));
    writeFileSync(qoder, '#!/bin/sh\n[ "$QODERCN_PERSONAL_ACCESS_TOKEN" = fixture-only ] || exit 1\n[ "$1" = --settings ] && [ "$2" = \'{"vpcInstanceName":"acme"}\' ]\n', { mode: 0o700 });
    const cloneRoot = join(root, 'clones');
    const clone = join(cloneRoot, 'runcheck');
    const profileRoot = join(root, 'profiles');
    mkdirSync(clone, { recursive: true });
    execFileSync('git', ['init', '-q', clone]);
    process.env.HOME = home;
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = 'fixture-only';
    try {
      const runtime = await createMacQoderRuntime({ cloneRoot, profileRoot, qoderPath: qoder });
      const proof = await runtime.boundary.attest({ runId: 'runcheck', repoKey: 'repo',
        workspacePath: clone, mode: 'read', mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'read',
          allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
          authority: { kind: 'trusted_rule', ruleRef: 'test' } } });
      assert.ok(proof);
      const launched = runtime.launcher.launch('qoderclicn', ['--version'], clone, proof);
      await new Promise<void>(resolve => launched.process.once('close', () => resolve()));
      assert.equal(launched.process.exitCode, 0);
      assert.throws(() => runtime.boundary.runCheck!({ proof: { ...proof, configDigest: 'forged' },
        command: '/usr/bin/git', args: ['status'], cwd: clone, timeoutMs: 5000,
        signal: new AbortController().signal }), /verified isolation/);
      const check = runtime.boundary.runCheck!({ proof, command: '/usr/bin/true',
        args: [], cwd: clone, timeoutMs: 5000, signal: new AbortController().signal });
      const passed = await check.completion;
      assert.equal(passed.result, 'passed');
      assert.equal(passed.terminationConfirmed, true);
      assert.equal(readFileSync(passed.logRef, 'utf8').trim(), '');
      const denied = runtime.boundary.runCheck!({ proof, command: '/usr/bin/touch',
        args: [join(root, 'outside')], cwd: clone, timeoutMs: 5000, signal: new AbortController().signal });
      assert.equal((await denied.completion).result, 'failed');
      assert.equal(existsSync(join(root, 'outside')), false);
      const credentialRead = runtime.boundary.runCheck!({ proof, command: '/bin/cat',
        args: [join(home, '.qoder-cn', 'sensitive')], cwd: clone, timeoutMs: 5000,
        signal: new AbortController().signal });
      assert.equal((await credentialRead.completion).result, 'failed');
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
      assert.equal(readdirSync(profileRoot).filter(name => name.endsWith('.sb')).length, 4);
      await restarted.boundary.release!(next);
      await runtime.boundary.release!(stale);
    } finally {
      process.env.HOME = previousHome;
      if (previousPat === undefined) delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
      else process.env.QODERCN_PERSONAL_ACCESS_TOKEN = previousPat;
      rmSync(root, { recursive: true, force: true });
    }
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
