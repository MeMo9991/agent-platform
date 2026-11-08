import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorkspaceManager } from '../src/agent/worker/workspace.js';

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
