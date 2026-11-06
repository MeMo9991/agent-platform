import type { SourceEvent } from '../../event/model.js';
import type { TaskCandidateFinder } from './model.js';

export type CandidateRow = { id: string; title: string; scope: string; origin_event_id: string | null;
  event_title: string | null; event_body: string | null; title_length: number; scope_length: number;
  event_title_length: number | null; event_body_length: number | null };

function pairs(value: string): Set<string> {
  const clean = Array.from(value.slice(0, 2048).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  return new Set(Array.from({ length: Math.max(clean.length - 1, 0) }, (_, index) => clean[index]! + clean[index + 1]!));
}

function similarity(left: Set<string>, right: Set<string>): { score: number; shared: number } {
  if (!left.size || !right.size) return { score: 0, shared: 0 };
  let shared = 0;
  for (const pair of left) if (right.has(pair)) shared++;
  return { score: 2 * shared / (left.size + right.size), shared };
}

export function createTaskCandidateFinder(store: { candidateRows(repoKey: string, excludedTaskId: string,
  limit: number): CandidateRow[] }): TaskCandidateFinder {
  return { find(event: SourceEvent, repoKey: string, excludedTaskId = '') {
    const rows = store.candidateRows(repoKey, excludedTaskId, 501);
    const title = pairs(event.title);
    const body = pairs(event.body);
    const candidates = rows.slice(0, 500).flatMap(row => {
      const oldTitle = pairs(row.event_title ?? row.title);
      const oldBody = pairs(row.event_body ?? '');
      const titleMatch = similarity(title, oldTitle);
      const bodyMatch = similarity(body, oldBody);
      const titleHit = titleMatch.score >= 0.45 && titleMatch.shared > 0 &&
        titleMatch.shared >= Math.min(3, title.size, oldTitle.size);
      const bodyHit = bodyMatch.score >= 0.4 && bodyMatch.shared > 0 &&
        bodyMatch.shared >= Math.min(5, body.size, oldBody.size);
      const field = titleHit && (!bodyHit || titleMatch.score >= bodyMatch.score) ? 'title'
        : bodyHit ? 'body' : undefined;
      if (!field) return [];
      const match = field === 'title' ? titleMatch : bodyMatch;
      return [{ taskId: row.id, evidence: [{ kind: 'text_similarity',
        sourceRef: row.origin_event_id ?? row.id,
        details: `${field} Dice score ${match.score.toFixed(3)}; ${match.shared} shared character pairs` }],
        score: match.score }];
    }).sort((left, right) => right.score - left.score || left.taskId.localeCompare(right.taskId))
      .slice(0, 5).map(({ score: _score, ...candidate }) => candidate);
    return { candidates, complete: rows.length <= 500 && (rows.length === 0 || title.size >= 3 || body.size >= 5) &&
      event.title.length <= 2048 &&
      event.body.length <= 2048 && rows.every(row => row.title_length <= 2048 && row.scope_length <= 2048 &&
      row.event_title !== null && row.event_body !== null &&
      (pairs(row.event_title).size >= 3 || pairs(row.event_body).size >= 5) &&
      row.event_title_length !== null && row.event_title_length <= 2048 &&
      row.event_body_length !== null && row.event_body_length <= 2048) };
  } };
}
