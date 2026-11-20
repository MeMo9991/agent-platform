import type { AgentEvent, Run } from '../worker/model.js';
import type { Task, TaskState } from './model.js';
import type { KernelSignal } from '../kernel/model.js';

export type WorkflowDecision = { state?: TaskState; queueStage?: 'investigate' | 'develop' | 'verify' | 'functional_verify' | 'review';
  needsScopeApproval?: boolean; needsManualDeliveryApproval?: boolean; reason?: string };

export function hasBlockingReviewFindings(findings: readonly { severity: string }[]): boolean {
  return findings.some(finding => typeof finding.severity !== 'string' ||
    !['low', 'medium'].includes(finding.severity.toLowerCase()));
}
export function isBlockingReview(review: { verdict: 'pass' | 'block';
  findings: readonly { severity: string }[] }): boolean {
  return review.verdict === 'block' || hasBlockingReviewFindings(review.findings);
}

export function decideAgentEvent(task: Task, run: Run, event: AgentEvent, hasPendingInput = false,
  previousReviewBlocks = 0, verificationConfigured = true,
  developmentChecksRequired = verificationConfigured, functionalVerificationConfigured = false): WorkflowDecision {
  if (run.taskId !== task.id || event.runId !== run.id || run.iteration !== task.iteration || run.status !== 'running')
    throw new Error('Agent event does not match the active Task and Run');
  if (event.kind === 'progress') return task.state === 'queued'
    ? { state: run.stage === 'investigate' ? 'investigating' : ['verify', 'functional_verify'].includes(run.stage) ? 'verifying'
      : run.stage === 'review' ? 'reviewing' : 'developing' } : {};
  if (event.kind === 'question') return {};
  if (event.kind !== 'result') return {};
  if (event.status === 'failed' || event.exitCode !== 0) return { state: 'failed' };
  if (!event.resultRef && !(run.stage === 'verify' && event.verification))
    return { state: 'blocked', reason: 'Successful Agent result has no verified result reference' };
  if (run.stage === 'develop') {
    const proof = event.development;
    if (!proof || proof.baseSha !== task.baseRef || proof.commitSha === proof.baseSha ||
        !proof.postCheckVerified || (developmentChecksRequired && proof.checks.length === 0) ||
        proof.checks.some(check => check.result !== 'passed' || check.exitCode !== 0 || !check.terminationConfirmed))
      return { state: 'blocked', reason: 'Development lacks matching diff, commit SHA and passing local checks' };
  }
  if (run.stage === 'verify') {
    const proof = event.verification;
    if (!proof || proof.subjectSha !== run.commitSha || !proof.postCheckVerified || proof.checks.length === 0)
      return { state: 'blocked', reason: 'Fixed-SHA verification lacks passing command evidence' };
    const failed = proof.checks.find(check => check.result !== 'passed' ||
      check.exitCode !== 0 || !check.terminationConfirmed);
    if (failed) return { state: 'blocked', reason: `Fixed-SHA check ${failed.command} ${failed.result} ` +
      `(exit ${failed.exitCode ?? 'unknown'}); inspect its check log` };
  }
  if (run.stage === 'functional_verify') {
    const proof = event.functionalVerification;
    if (!proof || proof.subjectSha !== run.commitSha)
      return { state: 'blocked', reason: 'Functional verification lacks evidence for its pinned SHA' };
    if (proof.verdict === 'unverifiable') return { state: 'waiting_human', reason: 'Local functional verification could not be completed' };
    if (proof.verdict === 'fail') return { state: 'developing', queueStage: 'develop', reason: 'Local functional verification failed' };
  }
  if (run.stage === 'review') {
    const review = event.review;
    if (!review || review.subjectSha !== run.commitSha)
      return { state: 'blocked', reason: 'Review lacks structured evidence for its pinned SHA' };
    if (review.verdict === 'block' && review.findings.length === 0)
      return { state: 'waiting_human', reason: 'Blocking review has no findings; human re-review is required' };
    if (isBlockingReview(review)) return previousReviewBlocks < 2
      ? { state: 'developing', queueStage: 'develop', reason: 'Review blocking findings require repair' }
      : { state: 'waiting_human', reason: 'Automatic repair limit reached' };
  }
  if (hasPendingInput && (run.stage === 'investigate' || run.stage === 'develop'))
    return { queueStage: run.stage };
  if (run.stage === 'investigate') return task.mandate.allowedActions.includes('edit')
    ? { state: 'developing', queueStage: 'develop' }
    : { state: 'waiting_human', needsScopeApproval: true };
  if (run.stage === 'develop') return verificationConfigured
    ? { state: 'verifying', queueStage: 'verify' }
    : { state: 'waiting_human', needsManualDeliveryApproval: true,
      reason: 'No verification command is configured; human approval is required for manual delivery' };
  if (run.stage === 'verify') return functionalVerificationConfigured
    ? { state: 'verifying', queueStage: 'functional_verify' }
    : { state: 'reviewing', queueStage: 'review' };
  if (run.stage === 'functional_verify') return { state: 'reviewing', queueStage: 'review' };
  if (run.stage === 'review') return { state: 'ready_to_merge' };
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
