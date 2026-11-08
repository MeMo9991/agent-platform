import { changeRef, changeSnapshot, checkResult, type CodeHost } from '../model.js';
import { baseUrl, credential, fullSha, jsonRequest, type Repository } from './http.js';

type Pull = { number: number; state: string; merged: boolean; mergeable: boolean | null;
  mergeable_state: string; merge_commit_sha?: string | null;
  head: { sha: string; ref: string }; base: { sha: string; ref: string } };
type CheckRun = { name: string; status: string; conclusion: string | null; head_sha: string; details_url?: string };
type Status = { context: string; state: string; sha?: string; target_url?: string };

export function createGitHubCodeHost(repo: Repository, fetcher: typeof fetch = fetch): CodeHost {
  if (repo.provider !== 'github' || !/^[^/]+\/[^/]+$/.test(repo.projectRef))
    throw new Error('GitHub repository identity is invalid');
  const api = `${baseUrl(repo, 'github')}/repos/${repo.projectRef.split('/').map(encodeURIComponent).join('/')}`;
  const request = <T>(path: string, method?: string, body?: unknown) =>
    jsonRequest<T>(`${api}${path}`, credential(repo), 'github', method, body, fetcher);
  async function branchSha(branch: string) {
    const value = await request<{ commit: { sha: string } }>(`/branches/${encodeURIComponent(branch)}`);
    return fullSha(value.commit.sha);
  }
  async function target(branch: string) {
    if (branch !== repo.targetBranch) throw new Error('Target branch differs from repository configuration');
    return branchSha(branch);
  }
  async function checks(sha: string) {
    fullSha(sha);
    const values: ReturnType<typeof checkResult.parse>[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await request<{ check_runs: CheckRun[] }>(`/commits/${sha}/check-runs?per_page=100&page=${page}`);
      for (const item of data.check_runs) values.push(checkResult.parse({ repoKey: repo.repoKey,
        commitSha: fullSha(item.head_sha), name: item.name,
        status: item.status === 'completed' ? 'completed' : 'pending',
        conclusion: item.conclusion === 'success' ? 'success' : item.status === 'completed' ? 'failure' : 'unknown',
        logRef: item.details_url }));
      if (data.check_runs.length < 100) break;
      if (page === 10) throw new Error('GitHub check-run pagination limit reached');
    }
    const seen = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const data = await request<{ statuses: Status[] }>(`/commits/${sha}/status?per_page=100&page=${page}`);
      for (const item of data.statuses) if (!seen.has(item.context)) {
        seen.add(item.context);
        values.push(checkResult.parse({ repoKey: repo.repoKey, commitSha: sha, name: item.context,
          status: item.state === 'pending' ? 'pending' : 'completed',
          conclusion: item.state === 'success' ? 'success' : item.state === 'pending' ? 'unknown' : 'failure',
          logRef: item.target_url }));
      }
      if (data.statuses.length < 100) break;
      if (page === 10) throw new Error('GitHub status pagination limit reached');
    }
    return values;
  }
  const ref = (pull: Pull, targetSha: string) => changeRef.parse({ provider: 'github', repoKey: repo.repoKey,
    id: String(pull.number), sourceSha: fullSha(pull.head.sha), targetSha });
  return { repoKey: repo.repoKey, provider: 'github', readTarget: target, readChecks: checks,
    async readRequiredChecks(branch) {
      if (branch !== repo.targetBranch) throw new Error('Target branch differs from repository configuration');
      const required = new Set<string>();
      let requiresPullRequest = false;
      for (let page = 1; page <= 10; page++) {
        const rules = await request<{ type: string; parameters?: {
          required_status_checks?: { context?: string }[];
          strict_required_status_checks_policy?: boolean } }[]>(
          `/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`);
        for (const rule of rules) {
          if (rule.type === 'pull_request') requiresPullRequest = true;
          if (rule.type === 'required_status_checks') {
            const checks = rule.parameters?.required_status_checks;
            if (!Array.isArray(checks) || checks.length === 0 ||
                rule.parameters?.strict_required_status_checks_policy !== true)
              throw new Error('Required check rule is incomplete or not strict');
            for (const check of checks) {
              if (!check.context) throw new Error('Required check context is missing');
              required.add(check.context);
            }
          }
        }
        if (rules.length < 100) {
          if (!requiresPullRequest || !required.size) throw new Error('Target branch has no enforceable pull request and check rules');
          return [...required];
        }
      }
      throw new Error('GitHub branch-rule pagination limit reached');
    },
    async findChangeByBranch(branch) {
      if (!/^agent-platform\/[A-Za-z0-9_-]+$/.test(branch)) throw new Error('Task branch is invalid');
      const owner = repo.projectRef.split('/')[0]!;
      for (let page = 1; page <= 10; page++) {
        const pulls = await request<Pull[]>(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100&page=${page}`);
        const found = pulls.find(pull => pull.head.ref === branch && pull.base.ref === repo.targetBranch);
        if (found) return ref(found, await target(repo.targetBranch));
        if (pulls.length < 100) return undefined;
      }
      throw new Error('GitHub pull-request pagination limit reached');
    },
    async openChange(input) {
      if (!input.sourceBranch || !/^agent-platform\/[A-Za-z0-9_-]+$/.test(input.sourceBranch) ||
          input.targetBranch !== repo.targetBranch || input.targetSha !== await target(repo.targetBranch) ||
          input.sourceSha !== await branchSha(input.sourceBranch))
        throw new Error('GitHub pull request target changed or branch is invalid');
      const pull = await request<Pull>('/pulls', 'POST', { head: input.sourceBranch,
        base: input.targetBranch, title: input.title ?? input.sourceBranch });
      if (fullSha(pull.head.sha) !== input.sourceSha || pull.base.ref !== input.targetBranch)
        throw new Error('Created GitHub pull request does not match the requested SHA and target');
      return ref(pull, input.targetSha);
    },
    async readChange(change) {
      if (change.provider !== 'github' || change.repoKey !== repo.repoKey || !/^\d+$/.test(change.id))
        throw new Error('GitHub change belongs to another repository');
      const pull = await request<Pull>(`/pulls/${change.id}`);
      if (pull.base.ref !== repo.targetBranch) throw new Error('GitHub pull request target changed');
      const targetSha = await target(repo.targetBranch);
      const mergedSha = pull.merged && pull.merge_commit_sha ? fullSha(pull.merge_commit_sha) : undefined;
      const mergedCommit = mergedSha ? await request<{ parents: { sha: string }[] }>(`/commits/${mergedSha}`) : undefined;
      const preMergeTargetSha = mergedCommit?.parents[0] ? fullSha(mergedCommit.parents[0].sha) : undefined;
      return changeSnapshot.parse({ change: ref(pull, targetSha), state: pull.merged ? 'merged'
        : pull.state === 'open' ? 'open' : 'closed', sourceSha: fullSha(pull.head.sha), targetSha,
        mergedSha, preMergeTargetSha,
        checks: await checks(pull.head.sha), gate: pull.merged ? 'ready'
          : pull.mergeable === true && pull.mergeable_state === 'clean' ? 'ready'
            : pull.mergeable === false || pull.mergeable_state === 'blocked' ? 'blocked' : 'unknown',
        observedAt: new Date().toISOString() });
    },
    async merge() { throw new Error('GitHub target-SHA-safe merge mode has not been verified'); },
  };
}
