import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectGroup } from '../src/bootstrap/config.js';
import { repositoryConfig } from '../src/repository-ci/model.js';
import { createRepositorySelector } from '../src/bootstrap/repository-selection.js';

test('project repository selection uses verified local repos, then defaults to the primary service', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-project-'));
  const root = join(directory, 'work');
  mkdirSync(root);
  const makeRepo = (repoKey: string, file: string) => {
    const path = join(root, repoKey);
    mkdirSync(path);
    execFileSync('git', ['init', '-q', path]);
    execFileSync('git', ['-C', path, 'remote', 'add', 'origin', `https://git.example/${repoKey}.git`]);
    writeFileSync(join(path, file), 'class Test {}');
    execFileSync('git', ['-C', path, 'add', file]);
    return repositoryConfig.parse({ repoKey, provider: 'gitlab', hostUrl: 'https://git.example',
      projectRef: repoKey, targetBranch: 'master', requiredChecks: [], credentialsRef: 'unconfigured', localPath: path });
  };
  try {
    const repos = [makeRepo('bommgmt', 'BomService.java'), makeRepo('partmgmt', 'PartService.java'),
      makeRepo('ui', 'UiPage.tsx')];
    writeFileSync(join(root, 'partmgmt', 'PartHandler.java'), 'class PartHandler {}');
    execFileSync('git', ['-C', join(root, 'partmgmt'), 'add', 'PartHandler.java']);
    const group = projectGroup.parse({ projectKey: 'cloudbom', repoKeys: ['bommgmt', 'partmgmt', 'ui'],
      defaultRepoKey: 'bommgmt', searchRoot: root });
    const select = createRepositorySelector(group, repos);
    assert.deepEqual(select('partmgmt 接口失败', ''), { repoKey: 'partmgmt', reason: 'repository-name' });
    assert.deepEqual(select('PartService PartHandler', ''), { repoKey: 'partmgmt', reason: 'file-name' });
    assert.deepEqual(select('中文缺陷', '无代码标识'), { repoKey: 'bommgmt', reason: 'default' });
    assert.deepEqual(select('build failed', ''), { repoKey: 'bommgmt', reason: 'default' });
    execFileSync('git', ['-C', join(root, 'partmgmt'), 'remote', 'set-url', 'origin', 'https://git.example/other.git']);
    assert.deepEqual(select('partmgmt 接口失败', ''), { repoKey: 'bommgmt', reason: 'default' });
    assert.equal(createRepositorySelector({ ...group, searchRoot: undefined }, repos)('partmgmt', ''), undefined);
    assert.equal(createRepositorySelector({ ...group, searchRoot: join(directory, 'missing') }, repos)('partmgmt', ''), undefined);
    assert.equal(createRepositorySelector(group, [{ ...repos[0]!, localPath: directory }])('缺陷', ''), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
