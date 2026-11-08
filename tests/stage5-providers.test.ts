import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubCodeHost } from '../src/repository-ci/providers/github.js';
import { createGitLabCodeHost } from '../src/repository-ci/providers/gitlab.js';
import { credential } from '../src/repository-ci/providers/http.js';

test('code-host credentials reject invisible characters before making an HTTP request', () => {
  const repo = { repoKey: 'repo', provider: 'github' as const, hostUrl: 'https://github.com',
    projectRef: 'team/repo', targetBranch: 'main', requiredChecks: ['verify'],
    credentialsRef: 'env:AGENT_STAGE5_TEST_TOKEN', localChecks: [] };
  try {
    process.env.AGENT_STAGE5_TEST_TOKEN = 'fixture-token\r';
    assert.throws(() => credential(repo), /whitespace, control or non-ASCII/);
    process.env.AGENT_STAGE5_TEST_TOKEN = 'fixture-token';
    assert.equal(credential(repo), 'fixture-token');
  } finally { delete process.env.AGENT_STAGE5_TEST_TOKEN; }
});

test('GitHub and GitLab normalize checks without mixing repository identities', async () => {
  process.env.AGENT_STAGE5_TEST_TOKEN = 'fixture-token';
  const sha = 'a'.repeat(40);
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/check-runs')) return Response.json({ check_runs: [
      { name: 'test', status: 'completed', conclusion: 'success', head_sha: sha }] });
    if (url.includes('/status?')) return Response.json({ statuses: [] });
    if (url.includes('/pipelines/7/jobs')) return Response.json([
      { name: 'test', status: 'success', commit: { id: sha } }]);
    if (url.includes('/pipelines?')) return Response.json([{ id: 7, sha, status: 'success' }]);
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  try {
    const base = { hostUrl: 'https://github.com', projectRef: 'team/one', targetBranch: 'main',
      requiredChecks: ['test'], credentialsRef: 'env:AGENT_STAGE5_TEST_TOKEN', localChecks: [] };
    const github = createGitHubCodeHost({ ...base, repoKey: 'one', provider: 'github' }, fetcher);
    const gitlab = createGitLabCodeHost({ ...base, repoKey: 'two', provider: 'gitlab',
      hostUrl: 'https://gitlab.example.test', projectRef: 'group/two' }, fetcher);
    assert.equal((await github.readChecks(sha))[0]?.repoKey, 'one');
    assert.equal((await gitlab.readChecks(sha))[0]?.repoKey, 'two');
    assert.ok(requests.some(url => url.startsWith('https://api.github.com/repos/team/one/')));
    assert.ok(requests.some(url => url.startsWith('https://gitlab.example.test/api/v4/projects/group%2Ftwo/')));
    await assert.rejects(github.merge({ change: { provider: 'github', repoKey: 'one', id: '1',
      sourceSha: sha, targetSha: 'b'.repeat(40) }, expectedSourceSha: sha }), /not been verified/);
  } finally { delete process.env.AGENT_STAGE5_TEST_TOKEN; }
});

test('GitHub reads every active required check and rejects incomplete branch rules', async () => {
  process.env.AGENT_STAGE5_TEST_TOKEN = 'fixture-token';
  const repo = { repoKey: 'one', provider: 'github' as const, hostUrl: 'https://github.com',
    projectRef: 'team/one', targetBranch: 'main', requiredChecks: ['local'],
    credentialsRef: 'env:AGENT_STAGE5_TEST_TOKEN', localChecks: [] };
  try {
    const host = createGitHubCodeHost(repo, (async () => Response.json([
      { type: 'pull_request' },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
        required_status_checks: [{ context: 'verify' }] } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
        required_status_checks: [{ context: 'security' }] } },
    ])) as typeof fetch);
    assert.deepEqual(await host.readRequiredChecks?.('main'), ['verify', 'security']);
    await assert.rejects(host.readRequiredChecks?.('other'), /Target branch differs/);
    const broken = createGitHubCodeHost(repo, (async () => Response.json([
      { type: 'pull_request' }, { type: 'required_status_checks', parameters: {} },
    ])) as typeof fetch);
    await assert.rejects(broken.readRequiredChecks?.('main'), /incomplete/);
  } finally { delete process.env.AGENT_STAGE5_TEST_TOKEN; }
});

test('GitLab blocks code-host actions without protected target and required pipelines', async () => {
  process.env.AGENT_STAGE5_TEST_TOKEN = 'fixture-token';
  const repo = { repoKey: 'two', provider: 'gitlab' as const, hostUrl: 'https://gitlab.example.test',
    projectRef: 'group/two', targetBranch: 'main', requiredChecks: ['verify'],
    credentialsRef: 'env:AGENT_STAGE5_TEST_TOKEN', localChecks: [] };
  try {
    const fetcher = (async (input: string | URL | Request) => Response.json(
      String(input).includes('/protected_branches/')
        ? { allow_force_push: false, merge_access_levels: [{ access_level: 40 }] }
        : { only_allow_merge_if_pipeline_succeeds: true })) as typeof fetch;
    assert.deepEqual(await createGitLabCodeHost(repo, fetcher).readRequiredChecks?.('main'), []);
    const unsafe = createGitLabCodeHost(repo, (async (input: string | URL | Request) => Response.json(
      String(input).includes('/protected_branches/')
        ? { allow_force_push: true, merge_access_levels: [{ access_level: 40 }] }
        : { only_allow_merge_if_pipeline_succeeds: true })) as typeof fetch);
    await assert.rejects(unsafe.readRequiredChecks?.('main'), /lacks required/);
  } finally { delete process.env.AGENT_STAGE5_TEST_TOKEN; }
});

test('merged snapshots expose the platform commit parent for target-SHA receipt checks', async () => {
  process.env.AGENT_STAGE5_TEST_TOKEN = 'fixture-token';
  const sourceSha = 'a'.repeat(40);
  const approvedTarget = 'b'.repeat(40);
  const mergedSha = 'c'.repeat(40);
  const currentTarget = 'd'.repeat(40);
  let githubParents = [{ sha: approvedTarget }, { sha: sourceSha }];
  let gitlabParents = [approvedTarget, sourceSha];
  try {
    const base = { repoKey: 'repo', targetBranch: 'main', requiredChecks: ['verify'],
      credentialsRef: 'env:AGENT_STAGE5_TEST_TOKEN', localChecks: [] };
    const github = createGitHubCodeHost({ ...base, provider: 'github', hostUrl: 'https://github.com',
      projectRef: 'team/repo' }, (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/pulls/42')) return Response.json({ number: 42, state: 'closed', merged: true,
        merge_commit_sha: mergedSha, mergeable: null, mergeable_state: 'unknown',
        head: { sha: sourceSha, ref: 'agent-platform/task' }, base: { sha: currentTarget, ref: 'main' } });
      if (url.includes(`/commits/${mergedSha}`)) return Response.json({ parents: githubParents });
      if (url.includes('/branches/main')) return Response.json({ commit: { sha: currentTarget } });
      if (url.includes('/check-runs')) return Response.json({ check_runs: [] });
      if (url.includes('/status?')) return Response.json({ statuses: [] });
      throw new Error(`Unexpected GitHub request ${url}`);
    }) as typeof fetch);
    const githubSnapshot = await github.readChange({ provider: 'github', repoKey: 'repo',
      id: '42', sourceSha, targetSha: approvedTarget });
    assert.equal(githubSnapshot.mergedSha, mergedSha);
    assert.equal(githubSnapshot.preMergeTargetSha, approvedTarget);
    githubParents = [{ sha: 'e'.repeat(40) }];
    assert.equal((await github.readChange({ provider: 'github', repoKey: 'repo',
      id: '42', sourceSha, targetSha: approvedTarget })).preMergeTargetSha, undefined);
    githubParents = [{ sha: 'e'.repeat(40) }, { sha: sourceSha }];
    assert.notEqual((await github.readChange({ provider: 'github', repoKey: 'repo',
      id: '42', sourceSha, targetSha: approvedTarget })).preMergeTargetSha, approvedTarget);
    const gitlab = createGitLabCodeHost({ ...base, provider: 'gitlab',
      hostUrl: 'https://gitlab.example.test', projectRef: 'team/repo' },
    (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/merge_requests/42')) return Response.json({ iid: 42, state: 'merged',
        source_branch: 'agent-platform/task', target_branch: 'main', sha: sourceSha,
        detailed_merge_status: 'mergeable', merge_commit_sha: mergedSha });
      if (url.includes(`/repository/commits/${mergedSha}`)) return Response.json({ parent_ids: gitlabParents });
      if (url.includes('/repository/branches/main')) return Response.json({ commit: { id: currentTarget } });
      if (url.includes('/pipelines?')) return Response.json([]);
      throw new Error(`Unexpected GitLab request ${url}`);
    }) as typeof fetch);
    const gitlabSnapshot = await gitlab.readChange({ provider: 'gitlab', repoKey: 'repo',
      id: '42', sourceSha, targetSha: approvedTarget });
    assert.equal(gitlabSnapshot.mergedSha, mergedSha);
    assert.equal(gitlabSnapshot.preMergeTargetSha, approvedTarget);
    gitlabParents = [approvedTarget];
    assert.equal((await gitlab.readChange({ provider: 'gitlab', repoKey: 'repo',
      id: '42', sourceSha, targetSha: approvedTarget })).preMergeTargetSha, undefined);
  } finally { delete process.env.AGENT_STAGE5_TEST_TOKEN; }
});
