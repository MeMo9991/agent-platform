import { changeRef, changeSnapshot, checkResult, type CodeHost } from '../model.js';
import { baseUrl, credential, fullSha, jsonRequest, type Repository } from './http.js';

type Merge = { iid: number; state: string; source_branch: string; target_branch: string;
  sha: string; detailed_merge_status: string; merge_commit_sha?: string | null;
  squash_commit_sha?: string | null };
type Pipeline = { id: number; sha: string; status: string; web_url?: string };
type Job = { name: string; status: string; web_url?: string; commit?: { id: string } };

export function createGitLabCodeHost(repo: Repository, fetcher: typeof fetch = fetch): CodeHost {
  if (repo.provider !== 'gitlab' || !repo.projectRef || repo.projectRef.startsWith('/'))
    throw new Error('GitLab repository identity is invalid');
  const api = `${baseUrl(repo, 'gitlab')}/projects/${encodeURIComponent(repo.projectRef)}`;
  const request = <T>(path: string, method?: string, body?: unknown) =>
    jsonRequest<T>(`${api}${path}`, credential(repo), 'gitlab', method, body, fetcher);
  async function branchSha(branch: string) {
    const value = await request<{ commit: { id: string } }>(`/repository/branches/${encodeURIComponent(branch)}`);
    return fullSha(value.commit.id);
  }
  async function target(branch: string) {
    if (branch !== repo.targetBranch) throw new Error('Target branch differs from repository configuration');
    return branchSha(branch);
  }
  async function checks(sha: string) {
    fullSha(sha);
    const values: ReturnType<typeof checkResult.parse>[] = [];
    for (let page = 1; page <= 10; page++) {
      const pipelines = await request<Pipeline[]>(`/pipelines?sha=${sha}&per_page=100&page=${page}`);
      for (const pipeline of pipelines) {
        if (fullSha(pipeline.sha) !== sha) continue;
        for (let jobPage = 1; jobPage <= 10; jobPage++) {
          const jobs = await request<Job[]>(`/pipelines/${pipeline.id}/jobs?per_page=100&page=${jobPage}`);
          for (const job of jobs) values.push(checkResult.parse({ repoKey: repo.repoKey,
            commitSha: job.commit?.id ? fullSha(job.commit.id) : sha, name: job.name,
            status: ['success', 'failed', 'canceled', 'skipped', 'manual'].includes(job.status) ? 'completed' : 'pending',
            conclusion: job.status === 'success' ? 'success' : job.status === 'failed' ? 'failure' : 'unknown',
            logRef: job.web_url }));
          if (jobs.length < 100) break;
          if (jobPage === 10) throw new Error('GitLab jobs pagination limit reached');
        }
      }
      if (pipelines.length < 100) break;
      if (page === 10) throw new Error('GitLab pipeline pagination limit reached');
    }
    return values;
  }
  const ref = (merge: Merge, targetSha: string) => changeRef.parse({ provider: 'gitlab', repoKey: repo.repoKey,
    id: String(merge.iid), sourceSha: fullSha(merge.sha), targetSha });
  return { repoKey: repo.repoKey, provider: 'gitlab', readTarget: target, readChecks: checks,
    async readRequiredChecks(branch) {
      if (branch !== repo.targetBranch) throw new Error('Target branch differs from repository configuration');
      const project = await request<{ only_allow_merge_if_pipeline_succeeds?: boolean }>('');
      const protectedBranch = await request<{ allow_force_push?: boolean;
        merge_access_levels?: unknown[] }>(`/protected_branches/${encodeURIComponent(branch)}`);
      if (project.only_allow_merge_if_pipeline_succeeds !== true ||
          protectedBranch.allow_force_push !== false ||
          !protectedBranch.merge_access_levels?.length)
        throw new Error('GitLab target branch lacks required pipeline or branch protection');
      return [];
    },
    async findChangeByBranch(branch) {
      if (!/^agent-platform\/[A-Za-z0-9_-]+$/.test(branch)) throw new Error('Task branch is invalid');
      for (let page = 1; page <= 10; page++) {
        const changes = await request<Merge[]>(`/merge_requests?state=all&source_branch=${encodeURIComponent(branch)}&per_page=100&page=${page}`);
        const found = changes.find(change => change.source_branch === branch && change.target_branch === repo.targetBranch);
        if (found) return ref(found, await target(repo.targetBranch));
        if (changes.length < 100) return undefined;
      }
      throw new Error('GitLab merge-request pagination limit reached');
    },
    async openChange(input) {
      if (!input.sourceBranch || !/^agent-platform\/[A-Za-z0-9_-]+$/.test(input.sourceBranch) ||
          input.targetBranch !== repo.targetBranch || input.targetSha !== await target(repo.targetBranch) ||
          input.sourceSha !== await branchSha(input.sourceBranch))
        throw new Error('GitLab merge request target changed or branch is invalid');
      const merge = await request<Merge>('/merge_requests', 'POST', { source_branch: input.sourceBranch,
        target_branch: input.targetBranch, title: input.title ?? input.sourceBranch });
      if (fullSha(merge.sha) !== input.sourceSha || merge.target_branch !== input.targetBranch)
        throw new Error('Created GitLab merge request does not match the requested SHA and target');
      return ref(merge, input.targetSha);
    },
    async readChange(change) {
      if (change.provider !== 'gitlab' || change.repoKey !== repo.repoKey || !/^\d+$/.test(change.id))
        throw new Error('GitLab change belongs to another repository');
      const merge = await request<Merge>(`/merge_requests/${change.id}`);
      if (merge.target_branch !== repo.targetBranch) throw new Error('GitLab merge request target changed');
      const targetSha = await target(repo.targetBranch);
      const mergedSha = merge.state === 'merged' && (merge.merge_commit_sha || merge.squash_commit_sha)
        ? fullSha(merge.merge_commit_sha || merge.squash_commit_sha) : undefined;
      const mergedCommit = mergedSha ? await request<{ parent_ids: string[] }>(
        `/repository/commits/${mergedSha}`) : undefined;
      const preMergeTargetSha = mergedCommit?.parent_ids[0]
        ? fullSha(mergedCommit.parent_ids[0]) : undefined;
      return changeSnapshot.parse({ change: ref(merge, targetSha), state: merge.state === 'merged'
        ? 'merged' : merge.state === 'opened' ? 'open' : 'closed',
        sourceSha: fullSha(merge.sha), targetSha, mergedSha, preMergeTargetSha,
        checks: await checks(merge.sha),
        gate: merge.state === 'merged' ? 'ready' : merge.detailed_merge_status === 'mergeable' ? 'ready'
          : ['conflict', 'ci_must_pass', 'not_approved'].includes(merge.detailed_merge_status) ? 'blocked' : 'unknown',
        observedAt: new Date().toISOString() });
    },
    async merge() { throw new Error('GitLab target-SHA-safe merge mode has not been verified'); },
  };
}
