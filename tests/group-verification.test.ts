import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorkspaceManager } from '../src/agent/worker/workspace.js';
import { platformConfig, configuredGroupVerification } from '../src/bootstrap/config.js';
import { changedMavenModules, changedMavenTests } from '../src/agent/worker/maven-modules.js';

test('changed Maven tests select only added or edited test classes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-platform-tests-'));
  try {
    git(root, 'init');
    mkdirSync(join(root, 'domain', 'src', 'test', 'java'), { recursive: true });
    writeFileSync(join(root, 'domain', 'src', 'test', 'java', 'OldTest.java'), 'class OldTest {}');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
    const base = git(root, 'rev-parse', 'HEAD');
    assert.deepEqual(await changedMavenTests(root, base, base), []);
    writeFileSync(join(root, 'domain', 'src', 'test', 'java', 'NewTest.java'), 'class NewTest {}');
    writeFileSync(join(root, 'domain', 'src', 'test', 'java', 'OldTest.java'), 'class OldTest { int x; }');
    writeFileSync(join(root, 'domain', 'src', 'test', 'java', 'Helper.java'), 'class Helper {}');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'targeted tests');
    assert.deepEqual(await changedMavenTests(root, base, git(root, 'rev-parse', 'HEAD')),
      ['NewTest', 'OldTest']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function git(path: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function repository(root: string, directory: string, repoKey: string) {
  const path = join(root, directory);
  mkdirSync(path);
  git(path, 'init');
  git(path, 'remote', 'add', 'origin', `https://git.example/team/${repoKey}.git`);
  writeFileSync(join(path, 'pom.xml'), `<project>${repoKey}</project>\n`);
  git(path, 'add', 'pom.xml');
  git(path, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
  return { path, remote: `https://git.example/team/${repoKey}.git` };
}

test('group verification snapshots every repository and detects changed check inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-platform-group-'));
  try {
    const first = repository(root, 'service-a', 'a');
    const second = repository(root, 'service-b', 'b');
    mkdirSync(join(root, 'CloudBom'));
    writeFileSync(join(root, 'CloudBom', 'pom.xml'), '<project>aggregate</project>\n');
    const repos = { a: first, b: second };
    const config = platformConfig.parse({ projectGroups: [{ projectKey: 'devops-project-cloudbom', searchRoot: root,
      repositories: Object.entries(repos).map(([repoKey, repo]) => ({ repoKey, provider: 'gitlab',
        hostUrl: 'https://git.example', projectRef: `team/${repoKey}`, targetBranch: 'dev',
        requiredChecks: [], credentialsRef: 'unconfigured', localPath: repo.path })),
      verification: true }],
      agents: [], budget: { maxRunMs: 1000 }, policyRef: 'p1' });
    assert.equal(configuredGroupVerification(config.projectGroups[0]!), true);
    assert.equal(configuredGroupVerification({ ...config.projectGroups[0]!, verification: false }), false);
    assert.equal(platformConfig.safeParse({ ...config, projectGroups: [{ ...config.projectGroups[0]!, verification: { checks: [] } }] }).success, false);
    const runtime = join(root, 'runtime');
    const workspace = createGitWorkspaceManager(repos, runtime, () => 'a',
      run => run.stage === 'verify' ? join(runtime, 'clones', 'develop') : undefined,
      undefined, undefined, { a: { projectKey: 'devops-project-cloudbom', searchRoot: root,
        buildFile: 'CloudBom/pom.xml', repositories: repos } });
    const now = new Date().toISOString();
    const develop = { id: 'develop', taskId: 'task', iteration: 1, stage: 'develop' as const,
      status: 'running' as const, priority: 0, attempt: 0, createdAt: now };
    const base = await workspace.prepare(develop);
    writeFileSync(join(base.path, 'pom.xml'), '<project>changed</project>\n');
    git(base.path, 'add', 'pom.xml');
    git(base.path, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'change');
    const sha = git(base.path, 'rev-parse', 'HEAD');
    const verify = { ...develop, id: 'verify', stage: 'verify' as const, commitSha: sha };
    await workspace.prepare(verify);
    const copy = await workspace.prepareCheckCopy!(verify);
    assert.equal(copy.groupManifest?.inputs.length, 2);
    assert.equal(copy.groupManifest?.inputs.find(item => item.repoKey === 'a')?.sha, sha);
    assert.equal(copy.groupManifest?.inputs.find(item => item.repoKey === 'b')?.sha,
      git(second.path, 'rev-parse', 'HEAD'));
    const running = { ...verify, workspaceRef: join(runtime, 'clones', 'verify'),
      checkWorkspaceRef: copy.path, groupManifest: copy.groupManifest };
    await workspace.verifyGroupCheckCopy!(running);
    writeFileSync(join(copy.path, 'service-b', 'pom.xml'), 'tampered\n');
    await assert.rejects(workspace.verifyGroupCheckCopy!(running), /changed during checks/);
    writeFileSync(join(copy.path, 'service-b', 'pom.xml'), '<project>b</project>\n');
    writeFileSync(join(copy.path, 'CloudBom', 'pom.xml'), 'tampered\n');
    await assert.rejects(workspace.verifyGroupCheckCopy!(running), /build file changed/);
    writeFileSync(join(copy.path, 'CloudBom', 'pom.xml'), '<project>aggregate</project>\n');
    writeFileSync(copy.groupManifest!.buildFileRef, 'tampered\n');
    await assert.rejects(workspace.verifyGroupCheckCopy!(running), /build evidence changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changed Maven modules come from pinned Git commits and reactor POMs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-platform-maven-modules-'));
  try {
    git(root, 'init');
    mkdirSync(join(root, 'domain'));
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'pom.xml'), '<project><modules><module>domain</module><module>app</module></modules></project>');
    writeFileSync(join(root, 'domain', 'pom.xml'), '<project/>');
    writeFileSync(join(root, 'app', 'pom.xml'), '<project/>');
    writeFileSync(join(root, 'domain', 'Service.java'), 'class Service {}');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'domain', 'Service.java'), 'class Service { int value; }');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'domain change');
    const domainSha = git(root, 'rev-parse', 'HEAD');
    assert.deepEqual(await changedMavenModules(root, base, domainSha), ['domain']);
    writeFileSync(join(root, 'pom.xml'), '<project><modules><module>domain</module><module>app</module></modules><name>new</name></project>');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'root change');
    assert.deepEqual(await changedMavenModules(root, domainSha, git(root, 'rev-parse', 'HEAD')),
      ['.', 'app', 'domain']);
    mkdirSync(join(root, 'unknown'));
    writeFileSync(join(root, 'unknown', 'pom.xml'), '<project/>');
    writeFileSync(join(root, 'unknown', 'Code.java'), 'class Code {}');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'unknown module');
    await assert.rejects(changedMavenModules(root, domainSha, git(root, 'rev-parse', 'HEAD')),
      /outside the reactor/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
