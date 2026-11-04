import { z } from 'zod';

export const id = z.string().trim().min(1);
export const timestamp = z.iso.datetime({ offset: true });
export const actorRef = z.object({ kind: z.enum(['human', 'agent', 'system']), id, source: id.optional() });
export const evidenceRef = z.object({ uri: id, kind: id, source: id.optional() });
export const failure = z.object({
  kind: z.enum(['invalid', 'conflict', 'not_found', 'forbidden', 'unavailable', 'retryable']),
  code: id,
  message: id,
});
export type PlatformFailure = z.infer<typeof failure>;
export function unavailable(code: string): never {
  throw Object.assign(new Error(`${code} is unavailable`), { kind: 'unavailable', code });
}
