import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventIngress } from '../event/model.js';
import { baseUrl, credential, fullSha, jsonRequest } from '../repository-ci/providers/http.js';
import type { PlatformConfig } from './config.js';
import type { TaskHandler } from './scheduler.js';

const pull = z.object({ number: z.number().int().positive(), title: z.string().min(1), body: z.string().nullable(),
  updated_at: z.iso.datetime({ offset: true }), draft: z.boolean(),
  head: z.object({ sha: z.string(), ref: z.string() }), base: z.object({ ref: z.string() }) });
export const githubPrMetadataFields = ['prNumber', 'headSha', 'baseBranch', 'draft'] as const;

export function createGithubPrTask(platform: PlatformConfig, ingress: EventIngress,
  request: typeof fetch = fetch): TaskHandler {
  return async task => {
    if (task.kind !== 'github-pr-poll') throw new Error('Expected GitHub PR scan');
    const group = platform.projectGroups.find(item => item.projectKey === task.projectKey);
    if (!group) throw new Error(`Unknown project group ${task.projectKey}`);
    for (const repo of group.repositories) {
      if (repo.provider !== 'github') throw new Error(`GitHub PR scan cannot read ${repo.repoKey}`);
      const api = `${baseUrl(repo, 'github')}/repos/${repo.projectRef.split('/').map(encodeURIComponent).join('/')}`;
      for (let page = 1; page <= 10; page++) {
        const values = z.array(pull).parse(await jsonRequest<unknown>(
          `${api}/pulls?state=open&base=${encodeURIComponent(repo.targetBranch)}&per_page=100&page=${page}`,
          credential(repo), 'github', 'GET', undefined, request));
        for (const item of values) {
          // shortcut: platform PRs use this branch prefix; link an effect receipt if external PRs reuse it.
          if (item.base.ref !== repo.targetBranch || /^agent-platform\/[A-Za-z0-9_-]+$/.test(item.head.ref)) continue;
          const body = item.body?.slice(0, 20_000) ?? '';
          const headSha = fullSha(item.head.sha);
          const externalId = `${repo.repoKey}#${item.number}`;
          const revision = createHash('sha256').update(JSON.stringify([
            item.updated_at, item.title, body, headSha, item.base.ref, item.draft])).digest('hex');
          await ingress.accept({ sourceId: task.id, externalId, objectKey: externalId, revision,
            kind: 'pull_request', title: item.title.slice(0, 200), body, repoKey: repo.repoKey,
            url: `${repo.hostUrl}/${repo.projectRef}/pull/${item.number}`, occurredAt: item.updated_at,
            attachments: [], metaData: { prNumber: item.number, headSha, baseBranch: item.base.ref, draft: item.draft } });
        }
        if (values.length < 100) break;
        // shortcut: scan at most 1000 open PRs per repository; use Link pagination if a larger repository is added.
        if (page === 10) throw new Error(`GitHub PR pagination limit reached for ${repo.repoKey}`);
      }
    }
  };
}
