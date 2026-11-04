import type { Task, TaskRecord, TaskState } from './model.js';
import type { z } from 'zod';
import type { actorRef } from '../../shared/model.js';

const next: Partial<Record<TaskState, TaskState[]>> = {
  new: ['triaged', 'cancelled'], triaged: ['queued', 'waiting_human', 'cancelled'],
  queued: ['investigating', 'paused', 'cancelled'], investigating: ['developing', 'waiting_human', 'blocked', 'failed', 'cancelled'],
  developing: ['verifying', 'waiting_human', 'blocked', 'failed', 'cancelled'],
  verifying: ['reviewing', 'developing', 'blocked', 'failed'], reviewing: ['ready_to_merge', 'developing', 'waiting_human', 'blocked'],
  ready_to_merge: ['merging', 'waiting_human', 'blocked'], merging: ['merged', 'blocked', 'failed'],
  merged: ['release_pending'], release_pending: ['releasing', 'waiting_human'],
  releasing: ['released', 'blocked', 'failed'], released: ['closed'],
  waiting_human: ['queued', 'investigating', 'developing', 'verifying', 'reviewing', 'ready_to_merge', 'release_pending', 'paused', 'cancelled'],
  paused: ['queued', 'cancelled'], blocked: ['queued', 'cancelled'], failed: ['queued', 'cancelled'],
};
export type TaskTransitionResult = { task: Task; record: Extract<TaskRecord, { kind: 'state_change' }> };
export function transitionTask(value: Task, to: TaskState, reason: string, at: string, recordId: string,
  actor: z.infer<typeof actorRef>): TaskTransitionResult {
  if (!reason.trim() || !next[value.state]?.includes(to)) throw new Error(`Invalid task transition ${value.state} -> ${to}`);
  return { task: { ...value, state: to, updatedAt: at },
    record: { id: recordId, taskId: value.id, kind: 'state_change', from: value.state, to, reason, actor, at } };
}
