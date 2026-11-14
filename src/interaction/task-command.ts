import { z } from 'zod';
import { id } from '../shared/model.js';

const base = z.object({ taskId: id, expectedVersion: z.number().int().positive(),
  idempotencyKey: id.max(200) }).strict();
const withReason = base.extend({ reason: z.string().trim().max(2000)
  .transform(value => value || '操作人未填写原因').default('操作人未填写原因') });
export const taskCommand = z.discriminatedUnion('kind', [
  withReason.extend({ kind: z.literal('pause') }),
  withReason.extend({ kind: z.literal('resume') }),
  withReason.extend({ kind: z.literal('retry') }),
  withReason.extend({ kind: z.literal('cancel') }),
  withReason.extend({ kind: z.literal('takeover') }),
  withReason.extend({ kind: z.literal('confirm_termination') }),
  withReason.extend({ kind: z.literal('complete') }),
  base.extend({ kind: z.literal('split'), description: z.string().trim().min(1).max(20_000) }),
  base.extend({ kind: z.literal('takeover_result'), summary: z.string().trim().min(1).max(2000),
    disposition: z.enum(['resume', 'cancel']), codeChange: z.enum(['none', 'committed']).default('none'),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional() }),
]);
export type TaskCommand = z.infer<typeof taskCommand>;
