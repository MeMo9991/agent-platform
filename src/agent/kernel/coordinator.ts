import { randomUUID } from 'node:crypto';
import type { KernelCoordinator, KernelSignal } from './model.js';
import type { EventLoopStore } from './event-loop.js';
import { createEventLoop } from './event-loop.js';
import type { Task, TaskState, TaskRecord } from '../task/model.js';
import type { Run } from '../worker/model.js';
import { decideAgentEvent, decideRunRecovery } from '../task/workflow.js';
import { decide, policyWarning, shouldWarn } from '../../authorization/policy/evaluate.js';
import type { ResolvedReview } from '../../authorization/policy/config.js';
import type { z } from 'zod';
import type { approvalRequest, approvalDecision, answer, routeReviewDecision } from '../../interaction/model.js';
import { routeReviewDecision as routeReviewDecisionSchema } from '../../interaction/model.js';
import { reopenTaskCommand } from '../../interaction/model.js';
import { answerResume, decideHumanRoute, planRoute, queuedRun, workerDisposition } from './task-loop.js';
import { reopenTask } from '../task/transition.js';
import type { SourceEvent } from '../../event/model.js';
import type { RouteDecision, TaskCandidateFinder } from '../router/model.js';

export interface KernelStore extends EventLoopStore {
  transaction<T>(action: () => T): T;
  getTask(id: string): Task | undefined;
  getRun(id: string): Run | undefined;
  saveTransition(taskId: string, to: TaskState, reason: string, at: string, recordId: string,
    actor: { kind: 'system' | 'human'; id: string }): unknown;
  saveRecord(record: TaskRecord): void;
  replaceRun(run: Run, expectedStatus: Run['status']): void;
  saveRun(run: Run): void;
  setEventLinkStatus(taskId: string, eventId: string, from: 'pending' | 'delivered' | 'uncertain',
    to: 'delivered' | 'handled' | 'uncertain' | 'handback'): void;
  handbackEvent(taskId: string, eventId: string, reason: string): void;
  saveApprovalRequest(input: z.infer<typeof approvalRequest>): void;
  recordAnswer(input: z.infer<typeof answer>): { task: Task; run: Run } | undefined;
  recordApproval(input: z.infer<typeof approvalDecision>): Task | undefined;
  get(id: string): SourceEvent | undefined;
  claimHumanRoute(eventId: string): void;
  auditHumanRoute(eventId: string, decision: RouteDecision,
    value: z.infer<typeof routeReviewDecision>, taskId: string | undefined): void;
  getRecord(id: string): TaskRecord | undefined;
  openQuestionForRun(runId: string): TaskRecord | undefined;
  hasPendingInput(taskId: string): boolean;
  countReviewBlocks(taskId: string, iteration: number): number;
  setRepairBaseRef(taskId: string, sourceSha: string): void;
  hasActiveRun(taskId: string): boolean;
  getReopenByKey(key: string): Extract<TaskRecord, { kind: 'reopen' }> | undefined;
  saveReopenedTask(previous: Task, next: Task, reopeningRecordId: string): void;
  transferInvestigation(relatedTaskId: string, targetTaskId: string, at: string): void;
  invalidateOpenApprovals(taskId: string, reopeningRecordId: string): void;
}

export function createKernelCoordinator(store: KernelStore, trustedRepoBySource: Readonly<Record<string, string | readonly string[]>>,
  policyVersion: string, ruleRef: string, agentKind: string,
  allowedRepos: readonly string[], finder: TaskCandidateFinder,
  autoMandate?: (event: SourceEvent) => Task['mandate'] | undefined,
  sourceRepoKeys: Readonly<Record<string, readonly string[]>> = {},
  reviewPolicy?: ResolvedReview): KernelCoordinator & { processPending(limit?: number): number;
    resolveHumanRoute(value: z.infer<typeof routeReviewDecision>): string | undefined } {
  const eventLoop = createEventLoop(store, trustedRepoBySource, policyVersion, ruleRef, agentKind, finder, 60_000, autoMandate);
  const actor = { kind: 'system' as const, id: 'kernel' };
  return {
    onQuestionProcessEnded(runId, sessionId) {
      store.transaction(() => {
        const run = store.getRun(runId);
        const task = run && store.getTask(run.taskId);
        const question = store.openQuestionForRun(runId);
        if (!run || run.status !== 'running' || run.sessionId !== sessionId ||
            !task || task.iteration !== run.iteration || !question || question.taskId !== task.id)
          throw new Error('Question handoff does not match the active Run and Session');
        const at = new Date().toISOString();
        store.replaceRun({ ...run, status: 'waiting_human', leaseUntil: undefined, workerId: undefined,
          questionTerminationVerified: true }, 'running');
        store.saveRecord({ id: randomUUID(), taskId: task.id, runId, kind: 'agent_report', status: 'progress',
          summary: 'Question process termination verified; waiting for a human answer', at });
        store.saveTransition(task.id, 'waiting_human', 'Agent process ended after asking a question',
          at, randomUUID(), actor);
      });
    },
    onWorkerFailure(runId, reason, kind, processTerminationUnconfirmed = false) {
      store.transaction(() => {
        const run = store.getRun(runId);
        const owner = run && store.getTask(run.taskId);
        if (!run || run.status !== 'running' || !owner || owner.iteration !== run.iteration)
          throw new Error('Run is no longer active');
        const at = new Date().toISOString();
        const next = workerDisposition(run, kind, at, processTerminationUnconfirmed);
        store.replaceRun(next.run, 'running');
        store.saveRecord({ id: randomUUID(), taskId: owner.id, runId, kind: 'agent_report', status: 'failed',
          summary: reason, at });
        if (kind === 'missing_skill' || (owner.state !== 'waiting_human' && owner.state !== 'paused'))
          store.saveTransition(owner.id, next.state, reason, at, randomUUID(),
            { kind: 'system', id: kind === 'pause' ? 'worker-manager' : 'skill-loader' });
      });
    },
    resolveHumanRoute(value) {
      value = routeReviewDecisionSchema.parse(value);
      return store.transaction(() => {
        const event = store.get(value.eventId);
        if (!event) throw new Error('Event is missing');
        const audit = event.routingData as { humanDecision?: z.infer<typeof routeReviewDecision>; taskId?: string } | undefined;
        if (event.status !== 'needs_human') {
          const prior = audit?.humanDecision;
          if (prior?.idempotencyKey === value.idempotencyKey && prior.actor.id === value.actor.id &&
              prior.choice === value.choice && prior.reason === value.reason &&
              (prior.choice !== 'new_task' || (value.choice === 'new_task' && prior.repoKey === value.repoKey &&
                prior.parentTaskId === value.parentTaskId)) &&
              (prior.choice !== 'existing_task' || (value.choice === 'existing_task' && prior.taskId === value.taskId)))
            return event.status === 'done' ? audit?.taskId : undefined;
          throw new Error('Route review is no longer open');
        }
        const owner = value.choice === 'existing_task' ? store.getTask(value.taskId)
          : value.choice === 'new_task' && value.parentTaskId ? store.getTask(value.parentTaskId) : undefined;
        const routed = decideHumanRoute(value, event, owner, sourceRepoKeys[event.sourceId] ?? allowedRepos, policyVersion);
        const automatic = routed.kind === 'new_task' ? autoMandate?.(event) : undefined;
        const decision = automatic && routed.kind === 'new_task' && automatic.repoKey === routed.repoKey
          ? { ...routed, mandate: automatic } : routed;
        const plan = planRoute(event, decision, owner, owner ? store.hasBusyRun(owner.id, owner.iteration) : false,
          agentKind, value.at);
        store.claimHumanRoute(event.id);
        const taskId = store.commitRoute(event.id, plan, value.at);
        store.auditHumanRoute(event.id, decision, value, taskId);
        return taskId;
      });
    },
    reopenTask(value) {
      value = reopenTaskCommand.parse(value);
      return store.transaction(() => {
        const prior = store.getReopenByKey(value.idempotencyKey);
        if (prior) {
          if (prior.taskId !== value.taskId || prior.relatedTaskId !== value.relatedTaskId ||
              prior.evidenceRunId !== value.evidenceRunId || prior.evidenceRecordId !== value.evidenceRecordId ||
              prior.finding !== value.finding || prior.reviewedSha !== value.reviewedSha ||
              prior.previousIteration !== value.expectedIteration || prior.previousUpdatedAt !== value.expectedUpdatedAt ||
              prior.actor.id !== value.actor.id || prior.reason !== value.reason)
            throw new Error('Idempotency key conflicts with another reopen decision');
          return { taskId: prior.taskId, iteration: prior.nextIteration };
        }
        const previous = store.getTask(value.taskId);
        const related = store.getTask(value.relatedTaskId);
        const run = store.getRun(value.evidenceRunId);
        const evidence = store.getRecord(value.evidenceRecordId);
        if (!previous || !related || !run || !evidence ||
            previous.iteration !== value.expectedIteration || previous.updatedAt !== value.expectedUpdatedAt ||
            !['released', 'closed'].includes(previous.state) || !allowedRepos.includes(previous.repoKey) ||
            previous.mandate.policyVersion !== policyVersion ||
            !previous.mandate.allowedActions.includes('investigate') ||
            related.parentTaskId !== previous.id || related.repoKey !== previous.repoKey ||
            related.state !== 'waiting_human' || related.iteration !== run.iteration ||
            related.baseRef !== value.reviewedSha || run.commitSha !== value.reviewedSha ||
            run.taskId !== related.id || run.stage !== 'investigate' || run.status !== 'succeeded' ||
            !run.resultRef || evidence.kind !== 'agent_report' || evidence.status !== 'succeeded' ||
            evidence.taskId !== related.id || evidence.runId !== run.id ||
            store.hasActiveRun(previous.id) || store.hasActiveRun(related.id) ||
            store.hasPendingInput(related.id))
          throw new Error('Reopen evidence, authorization or Task version is invalid');
        const reopenId = randomUUID();
        const next = reopenTask(previous, value.reason, value.at, randomUUID(), reopenId, value.actor);
        store.saveRecord({ id: reopenId, taskId: previous.id, kind: 'reopen',
          relatedTaskId: related.id, evidenceRunId: run.id, evidenceRecordId: evidence.id,
          finding: value.finding, reviewedSha: value.reviewedSha, previousIteration: previous.iteration,
          nextIteration: next.task.iteration, previousState: previous.state,
          previousUpdatedAt: previous.updatedAt, previousBaseSha: previous.baseRef,
          idempotencyKey: value.idempotencyKey, actor: value.actor, reason: value.reason, at: value.at });
        store.saveReopenedTask(previous, next.task, reopenId);
        store.saveRecord(next.record);
        store.saveTransition(related.id, 'cancelled', `Investigation transferred to ${previous.id}`,
          value.at, randomUUID(), value.actor);
        store.invalidateOpenApprovals(related.id, reopenId);
        store.saveRecord({ id: randomUUID(), taskId: related.id, kind: 'reopen_transfer',
          targetTaskId: previous.id, reopeningRecordId: reopenId, evidenceRunId: run.id, at: value.at });
        store.transferInvestigation(related.id, previous.id, value.at);
        store.saveRun(queuedRun(next.task, 'investigate', reopenId, randomUUID(), agentKind, value.at));
        return { taskId: previous.id, iteration: next.task.iteration };
      });
    },
    processPending(limit = 100) {
      let count = 0;
      while (count < limit && eventLoop.processOne()) count++;
      return count;
    },
    async onSignal(signal: KernelSignal) {
      if (signal.kind === 'source_event') { this.processPending(); return; }
      if (signal.kind === 'recovery') {
        if (!signal.runId || !signal.observation) throw new Error('Run recovery needs an observed process result');
        const run = store.getRun(signal.runId);
        const task = store.getTask(signal.taskId);
        if (!run || !task) throw new Error('Recovery Task or Run is missing');
        const decision = decideRunRecovery(task, run, signal.observation, !!store.openQuestionForRun(run.id));
        if (decision === 'keep_paused') return;
        if (decision === 'pause') {
          this.onWorkerFailure(run.id, signal.observation.kind === 'unknown'
            ? signal.observation.reason : 'Question process exited unsuccessfully',
          'pause', signal.observation.kind === 'unknown');
          return;
        }
        if (signal.observation.kind !== 'finished') throw new Error('Recovery has no finished process evidence');
        if (decision === 'confirm_termination') {
          const sessionId = signal.observation.sessionId;
          store.transaction(() => {
            const current = store.getRun(run.id);
            if (!current || current.status !== 'paused' || !current.processTerminationUnconfirmed ||
                current.sessionId !== sessionId)
              throw new Error('Run termination confirmation is stale');
            store.replaceRun({ ...current, processTerminationUnconfirmed: false }, 'paused');
            store.saveRecord({ id: randomUUID(), taskId: task.id, runId: run.id, kind: 'agent_report',
              status: 'progress', summary: 'Durable process termination evidence verified; automatic dispatch unblocked',
              at: new Date().toISOString() });
          });
          return;
        }
        if (decision === 'question_wait') { this.onQuestionProcessEnded(run.id, signal.observation.sessionId); return; }
        await this.onSignal({ kind: 'agent_event', taskId: task.id,
          event: { kind: 'result', runId: run.id, status: signal.observation.exitCode === 0 ? 'succeeded' : 'failed',
            exitCode: signal.observation.exitCode, resultRef: signal.observation.resultRef,
            development: signal.observation.development, verification: signal.observation.verification,
            review: signal.observation.review } });
        return;
      }
      if (signal.kind === 'human_response') {
        const response = signal.response;
        if (response.kind === 'answer') {
          const question = store.getRecord(response.value.questionId);
          if (signal.taskId && question?.taskId !== signal.taskId) throw new Error('Question belongs to another Task');
          if (!question || store.getTask(question.taskId)?.mandate.policyVersion !== policyVersion)
            throw new Error('Question policy is stale');
          store.transaction(() => {
            const resumed = store.recordAnswer(response.value);
            if (!resumed) return;
            const next = answerResume(resumed.run);
            store.replaceRun(next.run, 'waiting_human');
            store.saveTransition(resumed.task.id, next.state, 'Human answered worker',
              new Date().toISOString(), randomUUID(), response.value.actor);
          });
        } else if (response.kind === 'approval_decision') {
          const request = store.getRecord(response.value.requestId);
          if (signal.taskId && request?.taskId !== signal.taskId) throw new Error('Approval belongs to another Task');
          if (!request || store.getTask(request.taskId)?.mandate.policyVersion !== policyVersion)
            throw new Error('Approval policy is stale');
          store.transaction(() => {
            const approved = store.recordApproval(response.value);
            if (!approved) return;
            if (request.kind !== 'approval_request') throw new Error('Approval request changed');
            const approvedRequest = request.request as z.infer<typeof approvalRequest>;
            if (approvedRequest.kind === 'action') {
              store.saveTransition(approved.id, 'ready_to_merge', 'Approved code-host action',
                response.value.at, randomUUID(), response.value.actor);
            } else if (approvedRequest.kind === 'continue') {
              store.saveTransition(approved.id, 'verifying', '策略审批通过，继续验证',
                response.value.at, randomUUID(), response.value.actor);
              store.saveRun({ id: randomUUID(), taskId: approved.id, iteration: approved.iteration, stage: 'verify',
                status: 'queued', requestKey: `policy:${response.value.idempotencyKey}`, priority: approved.priority,
                attempt: 0, agentKind, commitSha: approvedRequest.sourceSha, createdAt: response.value.at });
            } else if (approvedRequest.proposedMandate.allowedActions.includes('open_pr') ||
                approvedRequest.proposedMandate.allowedActions.includes('merge')) {
              store.saveTransition(approved.id, 'ready_to_merge', 'Approved code-host scope',
                response.value.at, randomUUID(), response.value.actor);
            } else {
              store.saveTransition(approved.id, 'developing', 'Approved edit scope', response.value.at,
                randomUUID(), response.value.actor);
              store.saveRun(queuedRun(approved, 'develop', response.value.requestId, randomUUID(), agentKind,
                response.value.at));
            }
          });
        } else {
          if (signal.taskId && response.value.choice === 'existing_task' && signal.taskId !== response.value.taskId)
            throw new Error('Route decision belongs to another Task');
          this.resolveHumanRoute(response.value);
        }
        return;
      }
      if (signal.kind !== 'agent_event') throw new Error(`Kernel signal ${signal.kind} is not yet handled`);
      store.transaction(() => {
        const event = signal.event;
        const run = store.getRun(event.runId);
        let task = store.getTask(signal.taskId);
        if (!run || !task) throw new Error('Task or Run is missing');
        const taskId = task.id;
        const previousReviewBlocks = event.kind === 'result' && run.stage === 'review'
          ? store.countReviewBlocks(task.id, task.iteration) : 0;
        const saveDevelopmentEvidence = (at: string) => {
          const development = event.kind === 'result' ? event.development : undefined;
          if (!development) return;
          store.saveRecord({ id: randomUUID(), taskId, runId: run.id, kind: 'development',
            baseSha: development.baseSha, commitSha: development.commitSha, diffRef: development.diffRef,
            postCheckVerified: development.postCheckVerified, postCheckError: development.postCheckError, at });
          for (const check of development.checks) store.saveRecord({ id: randomUUID(), taskId,
            runId: run.id, kind: 'check', subjectSha: development.commitSha, ...check, at });
        };
        if (event.kind === 'result' && run.stage === 'develop' && event.development && reviewPolicy) {
          const context = { gate: 'develop-complete' as const, repoKey: task.repoKey, taskId: task.id, runId: run.id,
            baseSha: event.development.baseSha, commitSha: event.development.commitSha,
            paths: event.development.changedPaths ?? [] };
          const policy = decide(context, reviewPolicy);
          if (shouldWarn(policy) && policy) {
            store.saveRecord({ id: randomUUID(), taskId: task.id, runId: run.id,
              at: new Date().toISOString(), kind: 'policy_warning', ...policyWarning(context, policy) });
          }
          if (policy?.enforced && policy.decision.effect === 'deny') {
            const at = new Date().toISOString();
            const reason = `策略拒绝：${policy.decision.reason}`;
            store.saveRecord({ id: randomUUID(), taskId: task.id, runId: run.id, kind: 'agent_report',
              status: 'failed', summary: reason, at });
            store.replaceRun({ ...run, status: 'paused', leaseUntil: undefined, workerId: undefined, endedAt: at }, 'running');
            if (task.state !== 'waiting_human')
              store.saveTransition(task.id, 'waiting_human', reason, at, randomUUID(), actor);
            return;
          }
          if (policy?.enforced && policy.decision.effect === 'require-approval') {
            const at = new Date().toISOString();
            const reason = `策略要求审批：${policy.decision.reason}`;
            store.replaceRun({ ...run, status: 'succeeded', leaseUntil: undefined, workerId: undefined,
              commitSha: event.development.commitSha, resultRef: event.resultRef, endedAt: at }, 'running');
            saveDevelopmentEvidence(at);
            if (task.state !== 'waiting_human')
              store.saveTransition(task.id, 'waiting_human', reason, at, randomUUID(), actor);
            store.saveApprovalRequest({ kind: 'continue', id: `policy-${run.id}`, taskId: task.id,
              iteration: task.iteration, sourceSha: event.development.commitSha,
              policyVersion: task.mandate.policyVersion, reason: policy.decision.reason });
            return;
          }
        }
        const decision = decideAgentEvent(task, run, event, store.hasPendingInput(task.id), previousReviewBlocks);
        const at = new Date().toISOString();
        if (event.kind === 'input_handled') {
          store.setEventLinkStatus(task.id, event.eventId, 'delivered', 'handled');
          return;
        }
        if (event.kind === 'handback') {
          store.handbackEvent(task.id, event.eventId, event.reason);
          return;
        }
        if (event.kind === 'usage') {
          store.replaceRun({ ...run, usage: event.usage }, 'running');
          return;
        }
        if (task.state === 'queued' && run.stage === 'investigate') {
          store.saveTransition(task.id, 'investigating', 'Worker started', at, randomUUID(), actor);
          task = store.getTask(task.id)!;
        }
        if (event.kind === 'progress')
          store.saveRecord({ id: randomUUID(), taskId: task.id, runId: run.id, kind: 'agent_report', status: 'progress',
            summary: event.text.trim() || 'Worker progress', at });
        if (event.kind === 'question') {
          store.saveRecord({ id: event.questionId, taskId: task.id, runId: run.id, kind: 'question',
            prompt: event.prompt, status: 'open', at });
        }
        if (event.kind === 'result') {
          store.saveRecord({ id: randomUUID(), taskId: task.id, runId: run.id, kind: 'agent_report',
            status: decision.state === 'blocked' ? 'failed' : event.status,
            summary: decision.reason ?? event.resultRef ?? `Exit code ${event.exitCode ?? 'unknown'}`, at });
          saveDevelopmentEvidence(at);
          if (event.verification) for (const check of event.verification.checks)
            store.saveRecord({ id: randomUUID(), taskId: task.id, runId: run.id, kind: 'check',
              subjectSha: event.verification.subjectSha, ...check, at });
          if (event.review) store.saveRecord({ id: randomUUID(), taskId: task.id, runId: run.id,
            kind: 'review', iteration: task.iteration, ...event.review, at });
          store.replaceRun({ ...run, status: ['failed', 'blocked'].includes(decision.state ?? '') ? 'failed' : event.status,
            leaseUntil: undefined, workerId: undefined,
            resultRef: event.resultRef, commitSha: event.development?.commitSha ?? run.commitSha, endedAt: at }, 'running');
        }
        if (decision.state && task.state !== decision.state)
          store.saveTransition(task.id, decision.state, decision.reason ?? `Agent ${event.kind}`, at, randomUUID(), actor);
        if (event.kind === 'result' && run.stage === 'review' && decision.queueStage === 'develop' && event.review)
          store.setRepairBaseRef(task.id, event.review.subjectSha);
        if (decision.needsScopeApproval) {
          if (!task.baseRef) throw new Error('Cannot request edit scope without a verified base SHA');
          const requestId = `scope-${run.id}`;
          store.saveApprovalRequest({ kind: 'scope_change', id: requestId, taskId: task.id,
            iteration: task.iteration, sourceSha: task.baseRef, policyVersion: task.mandate.policyVersion,
            proposedMandate: { ...task.mandate, allowedActions: ['investigate', 'edit'],
              maxAutoRisk: 'high',
              authority: { kind: 'human_approval', approvalRef: requestId } } });
        }
        if (decision.queueStage) store.saveRun({ id: randomUUID(), taskId: task.id, iteration: task.iteration,
          stage: decision.queueStage, status: 'queued', requestKey: `${task.id}:${task.iteration}:${decision.queueStage}:${run.id}`,
          agentKind, priority: run.priority, attempt: 0, createdAt: at,
          commitSha: event.kind === 'result' ? event.development?.commitSha ?? event.verification?.subjectSha ??
            (decision.queueStage === 'develop' ? event.review?.subjectSha : undefined) : undefined });
      });
    },
  };
}
