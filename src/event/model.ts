import { z } from 'zod';
import { id, timestamp } from '../shared/model.js';

export const attachmentRef = z.object({
  id, kind: z.enum(['image', 'file']), sourceRef: id,
  stableKey: id.optional(), mimeType: id.optional(), expiresAt: timestamp.optional(),
}).strict().refine(value => [value.sourceRef, value.stableKey].every(ref =>
  ref === undefined || (!/^https?:\/\//i.test(ref) && !/[?#]/.test(ref))),
  'Attachment references must be opaque credential-free locators');
export type AttachmentRef = z.infer<typeof attachmentRef>;

const eventAssociation = z.object({ scope: id, phase: id, continueTask: z.boolean() }).strict();
export function associationFor(event: { metaData: Record<string, unknown> }) {
  return event.metaData.association === undefined ? undefined : eventAssociation.parse(event.metaData.association);
}

export const normalizedEvent = z.object({
  sourceId: id, externalId: id, revision: id, kind: id, title: id, body: z.string(),
  threadKey: id.optional(), objectKey: id.optional(), repoKey: id.optional(),
  url: z.url().optional(), occurredAt: timestamp.optional(),
  attachments: z.array(attachmentRef), metaData: z.record(z.string(), z.unknown()),
}).strict().superRefine((value, context) => {
  const text = JSON.stringify(value.metaData);
  if (text.length > 16_384 || /"[^"]*(?:password|token|secret|credential|api[_-]?key|authorization)[^"]*"\s*:/i.test(text)) {
    context.addIssue({ code: 'custom', message: 'metaData contains a secret-shaped key or exceeds 16 KiB' });
  }
});
export type NormalizedEvent = z.infer<typeof normalizedEvent>;
export type MetadataFields = Readonly<Record<string, readonly string[]>>;
export function validateMetadataFields(event: NormalizedEvent, allowed: MetadataFields): void {
  if (associationFor(event)?.continueTask && !event.objectKey)
    throw new Error('Task continuation requires an object key');
  const fields = allowed[event.sourceId];
  if (!fields || Object.keys(event.metaData).some(key => !fields.includes(key))) throw new Error(`Unapproved metaData field for source ${event.sourceId}`);
}
export const sourceEvent = normalizedEvent.safeExtend({
  id, status: z.enum(['pending', 'routing', 'needs_human', 'done']),
  leaseUntil: timestamp.optional(), routingData: z.unknown().optional(), receivedAt: timestamp,
});
export type SourceEvent = z.infer<typeof sourceEvent>;
export const sourceCursor = z.object({ sourceId: id, value: z.string() });
export interface EventRepository {
  accept(event: NormalizedEvent): { eventId: string; duplicate: boolean };
  get(id: string): SourceEvent | undefined;
  listPending(limit: number): SourceEvent[];
}
export interface EventIngress {
  accept(event: NormalizedEvent): Promise<{ eventId: string; duplicate: boolean }>;
}
export interface SourceNormalizer<Raw> { normalize(raw: Raw, sourceId: string): NormalizedEvent[] }
export interface PollingSource { read(cursor?: string): Promise<{ events: NormalizedEvent[]; nextCursor?: string }> }
export interface PushSource { verifyAndNormalize(raw: Uint8Array, headers: Record<string, string>): Promise<NormalizedEvent[]> }
export interface AttachmentReader { open(sourceId: string, ref: z.infer<typeof attachmentRef>): Promise<ReadableStream<Uint8Array>> }
