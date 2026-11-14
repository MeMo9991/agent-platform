import type { Task, TaskRecord, TaskState } from './model.js';
import type { z } from 'zod';
import type { actorRef } from '../../shared/model.js';

const next: Partial<Record<TaskState, TaskState[]>> = {
  new: ['triaged', 'cancelled', 'closed'], triaged: ['queued', 'waiting_human', 'cancelled', 'closed'],
  queued: ['investigating', 'developing', 'verifying', 'reviewing', 'waiting_human', 'paused', 'blocked', 'cancelled', 'closed'],
  investigating: ['developing', 'waiting_human', 'blocked', 'failed', 'cancelled', 'closed'],
  developing: ['verifying', 'waiting_human', 'blocked', 'failed', 'cancelled', 'closed'],
  verifying: ['reviewing', 'developing', 'blocked', 'failed', 'closed'],
  reviewing: ['ready_to_merge', 'developing', 'waiting_human', 'blocked', 'closed'],
  ready_to_merge: ['merging', 'waiting_human', 'blocked', 'closed'],
  merging: ['merged', 'blocked', 'failed', 'closed'],
  merged: ['release_pending', 'closed'], release_pending: ['releasing', 'waiting_human', 'closed'],
  releasing: ['released', 'blocked', 'failed', 'closed'], released: ['closed'],
  waiting_human: ['queued', 'investigating', 'developing', 'verifying', 'reviewing', 'ready_to_merge', 'release_pending', 'paused', 'blocked', 'cancelled', 'closed'],
  paused: ['queued', 'verifying', 'cancelled', 'closed'], blocked: ['queued', 'cancelled', 'closed'], failed: ['queued', 'cancelled', 'closed'],
};
export type TaskTransitionResult = { task: Task; record: Extract<TaskRecord, { kind: 'state_change' }> };
export function transitionTask(value: Task, to: TaskState, reason: string, at: string, recordId: string,
  actor: z.infer<typeof actorRef>): TaskTransitionResult {
  if (!reason.trim() || !next[value.state]?.includes(to)) throw new Error(`Invalid task transition ${value.state} -> ${to}`);
  return { task: { ...value, state: to, updatedAt: at },
    record: { id: recordId, taskId: value.id, kind: 'state_change', from: value.state, to, reason, actor, at } };
}
export function reopenTask(value: Task, reason: string, at: string, recordId: string, approvalRef: string,
  actor: z.infer<typeof actorRef>): TaskTransitionResult {
  if (!reason.trim() || !['released', 'closed'].includes(value.state) ||
      !value.mandate.allowedActions.includes('investigate'))
    throw new Error('Task cannot be reopened for investigation');
  return { task: { ...value, state: 'queued', iteration: value.iteration + 1, baseRef: undefined,
    mandate: { ...value.mandate, allowedActions: ['investigate'], maxAutoRisk: 'low',
      authority: { kind: 'human_approval', approvalRef } }, updatedAt: at },
  record: { id: recordId, taskId: value.id, kind: 'state_change', from: value.state, to: 'queued',
    reason, actor, at } };
}
