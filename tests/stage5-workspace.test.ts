import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorkspaceManager } from '../src/agent/worker/workspace.js';
import { createMacQoderRuntime } from '../src/agent/worker/mac-sandbox.js';

test('verify and review clone the unpushed development commit at a fixed SHA', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-stage5-workspace-'));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.test');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'remote', 'add', 'origin', 'https://example.test/team/repo.git');
    writeFileSync(join(repo, 'file.txt'), 'base\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const runtime = join(directory, 'runtime');
    const manager = createGitWorkspaceManager({ repo: { path: repo,
      remote: 'https://example.test/team/repo.git' } }, runtime, () => 'repo',
    () => join(runtime, 'clones', 'develop'));
    const at = new Date().toISOString();
    const development = await manager.prepare({ id: 'develop', taskId: 'task', iteration: 1,
      stage: 'develop', status: 'running', priority: 0, attempt: 1, createdAt: at });
    git(development.path, 'config', 'user.email', 'test@example.test');
    git(development.path, 'config', 'user.name', 'Test');
    writeFileSync(join(development.path, 'file.txt'), 'fixed\n');
    git(development.path, 'add', '.'); git(development.path, 'commit', '-qm', 'fix');
    const sha = git(development.path, 'rev-parse', 'HEAD');
    assert.notEqual(sha, git(repo, 'rev-parse', 'HEAD'));
    for (const stage of ['verify', 'review'] as const) {
      const workspace = await manager.prepare({ id: stage, taskId: 'task', iteration: 1,
        stage, status: 'running', priority: 0, attempt: 1, commitSha: sha, createdAt: at });
      assert.equal(git(workspace.path, 'rev-parse', 'HEAD'), sha);
      assert.equal(git(workspace.path, 'status', '--porcelain'), '');
      assert.equal(git(workspace.path, 'remote', 'get-url', 'origin'), 'https://example.test/team/repo.git');
    }
    const repair = await manager.prepare({ id: 'repair', taskId: 'task', iteration: 1,
      stage: 'develop', status: 'running', priority: 0, attempt: 1, commitSha: sha, createdAt: at });
    assert.equal(repair.baseSha, sha);
    await assert.rejects(manager.prepare({ id: 'wrong', taskId: 'task', iteration: 1,
      stage: 'verify', status: 'running', priority: 0, attempt: 1,
      commitSha: git(repo, 'rev-parse', 'HEAD'), createdAt: at }), /Pinned source clone changed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('trusted npm ci prepares dependencies outside the read-only Run clone',
  { skip: process.platform !== 'darwin' }, async () => {
    const root = mkdtempSync('/private/tmp/agent-stage5-dependencies-');
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    const clone = join(root, 'clones', 'verify');
    const previousHome = process.env.HOME;
    try {
      mkdirSync(join(home, '.qoder-cn'), { recursive: true });
      mkdirSync(bin, { recursive: true });
      mkdirSync(clone, { recursive: true });
      mkdirSync(join(clone, 'web'));
      const qoder = join(bin, 'qoderclicn');
      writeFileSync(qoder, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      writeFileSync(join(clone, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0',
        private: true, workspaces: ['web'], scripts: { check: "node -e \"require('fixture-web')\"" } }));
      writeFileSync(join(clone, 'web/package.json'), JSON.stringify({ name: 'fixture-web', version: '1.0.0', main: 'package.json' }));
      writeFileSync(join(clone, '.gitignore'), 'node_modules/\n');
      execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline'], { cwd: clone });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: clone, encoding: 'utf8' }).trim();
      git('init', '-q'); git('add', '.'); git('-c', 'user.email=test@example.test', '-c', 'user.name=Test',
        'commit', '-qm', 'fixture');
      process.env.HOME = home;
      const runtime = await createMacQoderRuntime({ cloneRoot: join(root, 'clones'),
        profileRoot: join(root, 'profiles'), qoderPath: qoder });
      const proof = await runtime.boundary.attest({ runId: 'verify', repoKey: 'repo',
        workspacePath: clone, mode: 'read', mandate: { sourceEventId: 'event', repoKey: 'repo',
          goal: 'verify', allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
          authority: { kind: 'trusted_rule', ruleRef: 'test' } } });
      assert.ok(proof);
      const launched = runtime.launcher.launch('qoderclicn', ['--version'], clone, proof);
      await new Promise<void>(resolve => launched.process.once('close', resolve));
      const prepared = await runtime.boundary.prepareDependencies!({ proof, cwd: clone });
      assert.equal(prepared.result, 'passed');
      assert.equal(prepared.terminationConfirmed, true);
      assert.match(realpathSync(join(clone, 'node_modules')), /dependency-install\/node_modules$/);
      const check = runtime.boundary.runCheck!({ proof, command: 'npm', args: ['run', 'check'],
        cwd: clone, timeoutMs: 5000, signal: new AbortController().signal });
      const checked = await check.completion;
      assert.equal(checked.result, 'passed', readFileSync(checked.logRef, 'utf8'));
      assert.equal(git('status', '--porcelain'), '');
      await runtime.boundary.release!(proof);
    } finally { process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
  });
