import type { z } from 'zod';
import type { repositoryConfig } from '../repository-ci/model.js';
import type { SqliteStore } from '../storage/sqlite/store.js';

export function scheduledMrApprovalCandidates(store: SqliteStore,
  repositories: readonly z.infer<typeof repositoryConfig>[],
  sourceIds: ReadonlySet<string>, writableRepos: ReadonlySet<string>): Array<{ taskId: string; version: number }> {
  const enabledRepos = new Set(repositories.filter(repo => repo.provider === 'gitlab' &&
    repo.autoPr?.enabled && writableRepos.has(repo.repoKey)).map(repo => repo.repoKey));
  if (!enabledRepos.size || !sourceIds.size) return [];
  const rows = store.db.prepare(`SELECT t.id, t.version, t.repo_key, e.source_id
    FROM task t JOIN source_event e ON e.id=t.origin_event_id
    WHERE t.state='ready_to_merge' AND json_extract(t.mandate,'$.authority.kind')='human_approval'
    AND EXISTS (SELECT 1 FROM json_each(t.mandate,'$.allowedActions') WHERE value='edit')
    AND e.kind='bug'`).all();
  const latestRequest = store.db.prepare(`SELECT status FROM task_record WHERE task_id=? AND kind='approval_request'
    AND status IN ('open','approved','rejected') AND json_extract(payload_json,'$.request.action')='open_pr'
    AND json_extract(payload_json,'$.request.reviewRecordId')=? ORDER BY at DESC, rowid DESC LIMIT 1`);
  const alreadyStarted = store.db.prepare(`SELECT 1 FROM task_record WHERE task_id=? AND kind='effect'
    AND subject_sha=? AND status IN ('pending','uncertain','done')
    AND json_extract(payload_json,'$.action')='open_pr' LIMIT 1`);
  const candidates: Array<{ taskId: string; version: number }> = [];
  for (const row of rows) {
    if (!enabledRepos.has(String(row.repo_key)) || !sourceIds.has(String(row.source_id))) continue;
    const taskId = String(row.id);
    const review = store.latestReview(taskId);
    if (!review || store.latestReviewedSha(taskId) !== review.subjectSha ||
        store.hasOpenHumanRequest(taskId) || latestRequest.get(taskId, review.id)?.status === 'rejected' ||
        alreadyStarted.get(taskId, review.subjectSha)) continue;
    candidates.push({ taskId, version: Number(row.version) });
  }
  return candidates;
}
