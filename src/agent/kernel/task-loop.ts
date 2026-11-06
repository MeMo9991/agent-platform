import type { Subscription, Task, TaskState } from '../task/model.js';
import type { Run } from '../worker/model.js';
import type { SourceEvent } from '../../event/model.js';
import type { RouteDecision } from '../router/model.js';
import { randomUUID } from 'node:crypto';
import { investigationMandate } from '../../authorization/model.js';
import type { routeReviewDecision } from '../../interaction/model.js';
import type { z } from 'zod';

export function wakeStageForLinkedEvent(task: Task, hasQueuedOrActiveRun: boolean): 'investigate' | 'develop' | undefined {
  if (hasQueuedOrActiveRun) return undefined;
  if (task.state === 'queued' || task.state === 'investigating') return 'investigate';
  if (task.state === 'developing' && task.mandate.allowedActions.includes('edit')) return 'develop';
  return undefined;
}

export function newTaskFromRoute(event: SourceEvent, decision: Extract<RouteDecision, { kind: 'new_task' }>,
  taskId: string, at: string): Task {
  return { id: taskId, originEventId: event.id, repoKey: decision.repoKey, title: event.title,
    scope: event.title, mandate: decision.mandate, state: 'new', iteration: 1, priority: 0,
    parentTaskId: decision.parentTaskId, createdAt: at, updatedAt: at };
}

export function queuedRun(task: Task, stage: 'investigate' | 'develop' | 'verify', signalId: string,
  runId: string, agentKind: string, at: string): Run {
  return { id: runId, taskId: task.id, iteration: task.iteration, stage, status: 'queued',
    requestKey: `${task.id}:${task.iteration}:${stage}:${signalId}`,
    priority: task.priority, attempt: 0, agentKind, createdAt: at };
}

export function linkedEventRun(task: Task, eventId: string, busy: boolean,
  runId: string, agentKind: string, at: string): Run | undefined {
  const stage = wakeStageForLinkedEvent(task, busy);
  return stage ? queuedRun(task, stage, eventId, runId, agentKind, at) : undefined;
}

export function answerResume(run: Run): { run: Run; state: TaskState } {
  if (run.stage !== 'investigate' && run.stage !== 'develop') throw new Error('Run stage cannot resume from an answer');
  return { run: { ...run, status: 'queued', queueClass: 'human_resume' },
    state: run.stage === 'investigate' ? 'investigating' : 'developing' };
}

export function workerDisposition(run: Run, kind: 'pause' | 'missing_skill', at: string,
  processTerminationUnconfirmed = false): { run: Run; state: TaskState } {
  return kind === 'pause'
    ? { run: { ...run, status: 'paused', leaseUntil: undefined, workerId: undefined,
        processTerminationUnconfirmed }, state: 'waiting_human' }
    : { run: { ...run, status: 'failed', leaseUntil: undefined, workerId: undefined, endedAt: at },
        state: 'blocked' };
}

export interface RoutePlan {
  decision: RouteDecision;
  task?: Task;
  run?: Run;
  taskId?: string;
  transitions?: readonly { state: TaskState; reason: string }[];
  subscriptions?: readonly Subscription[];
}

export function planRoute(event: SourceEvent, decision: RouteDecision, owner: Task | undefined,
  busy: boolean, agentKind: string, at: string): RoutePlan {
  if (decision.kind === 'new_task') {
    const task = newTaskFromRoute(event, decision, randomUUID(), at);
    const subscriptions: Subscription[] = [];
    if (event.objectKey) subscriptions.push({ taskId: task.id, sourceId: event.sourceId,
      targetKind: 'object', targetKey: event.objectKey, mode: 'handle' });
    if (event.threadKey) subscriptions.push({ taskId: task.id, sourceId: event.sourceId,
      targetKind: 'thread', targetKey: event.threadKey, mode: 'handle' });
    return { decision, task, taskId: task.id,
      transitions: [{ state: 'triaged', reason: 'Trusted event accepted' },
        { state: 'queued', reason: 'Investigation queued' }], subscriptions,
      run: queuedRun(task, 'investigate', event.id, randomUUID(), agentKind, at) };
  }
  if (decision.kind === 'existing_task') {
    if (!owner || owner.id !== decision.taskId) throw new Error('Route owner is missing');
    return { decision, taskId: owner.id,
      run: linkedEventRun(owner, event.id, busy, randomUUID(), agentKind, at) };
  }
  return { decision };
}

export function decideHumanRoute(value: z.infer<typeof routeReviewDecision>, event: SourceEvent,
  owner: Task | undefined, allowedRepos: readonly string[], policyVersion: string): RouteDecision {
  if (value.choice === 'ignored') return { kind: 'ignored', reason: value.reason };
  if (value.choice === 'new_task') {
    if (!allowedRepos.includes(value.repoKey) || (event.repoKey && event.repoKey !== value.repoKey))
      throw new Error('Repository is not permitted for this event');
    if (value.parentTaskId && (!owner || owner.id !== value.parentTaskId || owner.repoKey !== value.repoKey))
      throw new Error('Related Task must exist in the selected repository');
    return { kind: 'new_task', repoKey: value.repoKey, parentTaskId: value.parentTaskId, contextTaskIds: [],
      mandate: investigationMandate(event.id, value.repoKey, event.title, policyVersion,
        `human-route:${value.idempotencyKey}`) };
  }
  if (!owner || !allowedRepos.includes(owner.repoKey) || (event.repoKey && event.repoKey !== owner.repoKey))
    throw new Error('Route owner is not permitted');
  return { kind: 'existing_task', taskId: owner.id, contextTaskIds: [],
    evidence: [{ kind: 'human_review', sourceRef: value.idempotencyKey, details: value.reason }] };
}
