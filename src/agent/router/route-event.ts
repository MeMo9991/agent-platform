import type { SourceEvent } from '../../event/model.js';
import type { TaskMandate } from '../task/model.js';
import { investigationMandate } from '../../authorization/model.js';
import type { Task, Subscription } from '../task/model.js';
import type { RouteDecision, TaskCandidateFinder } from './model.js';

type Match = { task: Task; subscription: Subscription };
const ended = new Set(['released', 'closed', 'cancelled']);

export function routeEvent(event: SourceEvent, matches: readonly Match[], trustedRepoKey: string | undefined,
  policyVersion: string, ruleRef: string, findCandidates: TaskCandidateFinder['find'],
  excludedTaskId?: string, autoMandate?: (event: SourceEvent) => TaskMandate | undefined): RouteDecision {
  if (!trustedRepoKey || (event.repoKey && event.repoKey !== trustedRepoKey))
    return { kind: 'needs_human', candidates: [], reason: 'Source has no trusted matching repository' };
  const handle = [...new Map(matches.filter(match => match.subscription.mode === 'handle' && match.task.id !== excludedTaskId)
    .map(match => [match.task.id, match.task])).values()];
  const contextTaskIds = [...new Set(matches.filter(match => match.subscription.mode === 'context')
    .filter(match => match.task.repoKey === trustedRepoKey)
    .map(match => match.task.id))];
  const active = handle.filter(task => !ended.has(task.state) && task.repoKey === trustedRepoKey &&
    task.mandate.allowedActions.includes('investigate'));
  if (handle.length === 1 && active.length === 1) {
    const task = active[0]!;
    return { kind: 'existing_task', taskId: task.id, contextTaskIds: contextTaskIds.filter(id => id !== task.id),
      evidence: [{ kind: 'subscription', sourceRef: `${event.sourceId}/${event.objectKey ?? event.threadKey ?? event.externalId}`,
        details: 'Unique active handle subscription' }] };
  }
  if (handle.length > 1 || handle.some(task => task.repoKey !== trustedRepoKey) ||
      (handle.length === 1 && active.length === 0 && !ended.has(handle[0]!.state)))
    return { kind: 'needs_human', candidates: handle.map(task => ({ taskId: task.id, evidence: [] })),
      reason: 'Subscription ownership is ambiguous or out of scope' };
  const endedHandle = handle.length === 1 && ended.has(handle[0]!.state) ? handle[0]!.id : undefined;
  if (!endedHandle) {
    const search = findCandidates(event, trustedRepoKey, excludedTaskId);
    if (search.candidates.length || !search.complete || event.attachments.some(item => item.kind === 'image'))
      return { kind: 'needs_human', candidates: search.candidates,
        reason: !search.complete ? 'Candidate search was incomplete' : search.candidates.length
          ? 'Similar prior Task needs human routing' : 'Image needs human comparison' };
  }
  const parentTaskId = excludedTaskId ?? endedHandle;
  return { kind: 'new_task', repoKey: trustedRepoKey, parentTaskId, contextTaskIds,
    mandate: autoMandate?.(event) ?? investigationMandate(event.id, trustedRepoKey, event.title, policyVersion, ruleRef) };
}
