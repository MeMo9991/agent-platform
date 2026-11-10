import type { Detail } from './types';

export function canInterruptTask(detail: Detail): boolean {
  const activeRun = detail.runs.filter(run => ['running', 'queued', 'waiting_human'].includes(run.status)).at(-1);
  return !detail.task.owner && ['queued', 'investigating', 'developing', 'waiting_human'].includes(detail.task.state) &&
    activeRun?.status !== 'waiting_human' &&
    !detail.records.some(record => (record.kind === 'question' || record.kind === 'approval_request') && record.status === 'open');
}
