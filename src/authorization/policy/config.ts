import { createHash } from 'node:crypto';
import { z } from 'zod';

export const reviewConfig = z.object({
  bundle: z.string().trim().min(1).default('review-v1'),
  mode: z.enum(['off', 'shadow', 'warn', 'enforce']).default('shadow'),
  gates: z.object({
    edit: z.enum(['auto', 'approval']).default('auto'),
    openPr: z.enum(['auto', 'approval']).default('auto'),
    merge: z.literal('human').default('human'),
  }).default({ edit: 'auto', openPr: 'auto', merge: 'human' }),
  limits: z.object({
    maxFiles: z.number().int().positive().default(50),
    maxChangedLines: z.number().int().positive().default(2000),
  }).default({ maxFiles: 50, maxChangedLines: 2000 }),
  maxRisk: z.enum(['low', 'medium', 'high']).default('medium'),
  contentDeny: z.array(z.string().trim().min(1)).max(50).default([]),
}).strict();
export type ReviewConfig = z.infer<typeof reviewConfig>;
export type ResolvedReview = { config: ReviewConfig; fingerprint: string };

export function resolveReview(raw: unknown, policyVersion: string): ResolvedReview | undefined {
  if (raw === undefined || raw === null) return undefined;
  const config = reviewConfig.parse(raw);
  return { config, fingerprint: createHash('sha256')
    .update(JSON.stringify([config, policyVersion])).digest('hex') };
}
