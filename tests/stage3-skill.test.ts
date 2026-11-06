import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitSkillLoader } from '../src/skills/git-loader.js';

test('SkillLoader reads the pinned Git revision and rejects empty or escaping skills', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-skill-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', 'Test');
    mkdirSync(join(cwd, 'skills', 'investigate'), { recursive: true });
    const path = join(cwd, 'skills', 'investigate', 'SKILL.md');
    writeFileSync(path, '');
    git('add', '.'); git('commit', '-qm', 'empty');
    const emptySha = git('rev-parse', 'HEAD');
    writeFileSync(path, 'Investigate safely.\n');
    git('add', '.'); git('commit', '-qm', 'filled');
    const filledSha = git('rev-parse', 'HEAD');
    const loader = createGitSkillLoader({ platform: cwd });
    await assert.rejects(loader.load({ repoRef: 'platform', path: 'skills/investigate/SKILL.md',
      commitSha: emptySha, stage: 'investigate' }), /empty/);
    const loaded = await loader.load({ repoRef: 'platform', path: 'skills/investigate/SKILL.md',
      commitSha: filledSha, stage: 'investigate' });
    assert.match(loaded.content, /Investigate safely/);
    await assert.rejects(loader.load({ repoRef: 'platform', path: '../secret', commitSha: filledSha,
      stage: 'investigate' }));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
