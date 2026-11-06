import type { AgentEvent, Run } from '../worker/model.js';
import type { Task, TaskState } from './model.js';
import type { KernelSignal } from '../kernel/model.js';

export type WorkflowDecision = { state?: TaskState; queueStage?: 'investigate' | 'develop' | 'verify';
  needsScopeApproval?: boolean; reason?: string };

export function decideAgentEvent(task: Task, run: Run, event: AgentEvent, hasPendingInput = false): WorkflowDecision {
  if (run.taskId !== task.id || event.runId !== run.id || run.iteration !== task.iteration || run.status !== 'running')
    throw new Error('Agent event does not match the active Task and Run');
  if (event.kind === 'progress') return task.state === 'queued'
    ? { state: run.stage === 'investigate' ? 'investigating' : 'developing' } : {};
  if (event.kind === 'question') return {};
  if (event.kind !== 'result') return {};
  if (event.status === 'failed' || event.exitCode !== 0) return { state: 'failed' };
  if (!event.resultRef) return { state: 'blocked', reason: 'Successful Agent result has no verified result reference' };
  if (run.stage === 'develop') {
    const proof = event.development;
    if (!proof || proof.baseSha !== task.baseRef || proof.commitSha === proof.baseSha ||
        !proof.postCheckVerified || proof.checks.length === 0 ||
        proof.checks.some(check => check.result !== 'passed' || check.exitCode !== 0 || !check.terminationConfirmed))
      return { state: 'blocked', reason: 'Development lacks matching diff, commit SHA and passing local checks' };
  }
  if (hasPendingInput && (run.stage === 'investigate' || run.stage === 'develop'))
    return { queueStage: run.stage };
  if (run.stage === 'investigate') return task.mandate.allowedActions.includes('edit')
    ? { state: 'developing', queueStage: 'develop' }
    : { state: 'waiting_human', needsScopeApproval: true };
  if (run.stage === 'develop') return { state: 'verifying', queueStage: 'verify' };
  throw new Error(`Stage ${run.stage} is not executed in stage three`);
}

export function decideRunRecovery(task: Task, run: Run,
  observation: NonNullable<Extract<KernelSignal, { kind: 'recovery' }>['observation']>,
  hasOpenQuestion: boolean): 'pause' | 'keep_paused' | 'confirm_termination' | 'question_wait' | 'result' {
  if (run.taskId !== task.id || run.iteration !== task.iteration)
    throw new Error('Recovery does not match the Task and Run');
  if (observation.kind === 'unknown') {
    if (run.status === 'running') return 'pause';
    if (run.status === 'paused' && run.processTerminationUnconfirmed) return 'keep_paused';
    throw new Error('Run is not awaiting recovery');
  }
  if (run.sessionId !== observation.sessionId) throw new Error('Recovery Session does not match the Run');
  if (run.status === 'paused' && run.processTerminationUnconfirmed) return 'confirm_termination';
  if (run.status !== 'running') throw new Error('Run is not active for recovery');
  if (hasOpenQuestion) return observation.exitCode === 0 ? 'question_wait' : 'pause';
  return 'result';
}
