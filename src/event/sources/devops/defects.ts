import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NormalizedEvent, PollingSource } from '../../model.js';

export const defectStatuses = [3166016, 3166017, 3166019] as const;
export const isDefectFeedback = (status: unknown): boolean => status === 3166017 || status === 3166019;

export const defect = z.object({
  id: z.number().int().positive(), subject: z.string().trim().min(1),
  businessProjectId: z.number().int().positive(), type: z.literal('defect'),
  statusId: z.number().int(), description: z.string().nullable(),
  descriptionId: z.string().nullable(), gmtCreated: z.string(), gmtModified: z.string().min(1),
  priority: z.string().nullable(), environment: z.string().nullable(),
});
const defectPage = z.object({
  code: z.string(), success: z.literal(true),
  data: z.object({ pageNum: z.number().int().positive(), pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(), list: z.array(defect) }),
});
export const defectMetadataFields = ['businessProjectId', 'statusId', 'descriptionId', 'priority', 'environment', 'gmtCreated', 'gmtModified', 'repositorySelection', 'association'] as const;
export type DefectSourceConfig = { sourceId: string; businessProjectId: number; pageSize?: number };
export type RepositorySelection = { repoKey: string; reason: 'repository-name' | 'file-name' | 'default' };

export function defectAssociation(project: number, status: number) {
  return { scope: String(project), phase: String(status), continueTask: isDefectFeedback(status) };
}

export function defectAttachmentKey(sourceRef: string): string {
  return sourceRef.replace(/^(devops-file\/[a-f0-9]{32})\/[a-f0-9]{32}$/, '$1');
}

export function defectRevision(event: Pick<NormalizedEvent, 'title' | 'body' | 'attachments' | 'metaData'>): string {
  const { gmtModified, descriptionId, statusId, priority, environment } = event.metaData;
  // DevOps rotates the last segment of the download reference for the same file.
  const files = event.attachments.map(ref => defectAttachmentKey(ref.sourceRef));
  const facts = [gmtModified, event.title, event.body, files, descriptionId, statusId, priority, environment];
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

export function normalizeDefect(raw: z.infer<typeof defect>, config: DefectSourceConfig,
  detail: { body: string; attachments: NormalizedEvent['attachments'] }, selection?: RepositorySelection): NormalizedEvent {
  if (raw.businessProjectId !== config.businessProjectId) throw new Error(`Unexpected project for defect ${raw.id}`);
  const event = {
    sourceId: config.sourceId, externalId: String(raw.id), objectKey: String(raw.id), kind: 'bug' as const,
    title: raw.subject, body: detail.body, repoKey: selection?.repoKey,
    attachments: detail.attachments,
    metaData: { businessProjectId: raw.businessProjectId, statusId: raw.statusId, descriptionId: raw.descriptionId,
      association: defectAssociation(raw.businessProjectId, raw.statusId),
      priority: raw.priority, environment: raw.environment, gmtCreated: raw.gmtCreated, gmtModified: raw.gmtModified,
      ...(selection ? { repositorySelection: selection.reason } : {}) },
  };
  // shortcut: a same-status reopen between scans needs a status transition identifier from DevOps.
  const revision = defectRevision(isDefectFeedback(raw.statusId)
    ? { ...event, metaData: { ...event.metaData, gmtModified: undefined } }
    : event);
  return { ...event, revision };
}

export function parseDefectPage(payload: unknown, config: DefectSourceConfig, expectedPage: number): { items: z.infer<typeof defect>[]; nextCursor?: string } {
  const result = defectPage.parse(payload);
  if (result.code !== '200' || result.data.pageNum !== expectedPage || result.data.pageSize !== (config.pageSize ?? 10))
    throw new Error('Unexpected defect list response');
  return { items: result.data.list,
    ...(expectedPage * result.data.pageSize < result.data.total ? { nextCursor: String(expectedPage + 1) } : {}) };
}

export function parseDefectComments(payload: unknown, itemId: number): string {
  const fields = z.object({ id: z.number().int().positive(), itemId: z.number().int(),
    gmtCreated: z.iso.datetime({ offset: true }), content: z.string(), children: z.array(z.unknown()).nullish() });
  const { data } = z.object({ code: z.literal('200'), success: z.literal(true), data: z.array(z.unknown()) }).parse(payload);
  const lines: string[] = [];
  function append(items: unknown[], depth: number): void {
    if (depth > 16) throw new Error('Defect comment nesting exceeds the limit');
    for (const item of items.map(value => fields.parse(value))
      .sort((a, b) => Date.parse(a.gmtCreated) - Date.parse(b.gmtCreated) || a.id - b.id)) {
      if (item.itemId !== itemId) throw new Error('Unexpected defect comment identity');
      const { body } = parseDescription(item.content, false);
      const indent = '  '.repeat(depth);
      if (body) lines.push(`${indent}- ${depth ? '回复：' : ''}${body.replaceAll('\n', `\n${indent}  `)}`);
      if (item.children?.length) append(item.children, depth + 1);
    }
  }
  append(data, 0);
  return lines.join('\n');
}

export function createDefectSource(config: DefectSourceConfig, readPage: (page: number) => Promise<unknown>,
  readDetail: (id: number) => Promise<unknown>,
  selectRepository?: (title: string, body: string) => RepositorySelection | undefined,
  readComments?: (id: number) => Promise<unknown>): PollingSource {
  return { async read(cursor) {
    const page = cursor === undefined ? 1 : Number(cursor);
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid page cursor');
    const result = parseDefectPage(await readPage(page), config, page);
    const events: NormalizedEvent[] = [];
    for (const item of result.items) {
      const detail = parseDefectDetail(await readDetail(item.id), item.id, config.businessProjectId);
      if (!defectStatuses.some(status => status === detail.item.statusId)) continue;
      const feedback = isDefectFeedback(detail.item.statusId);
      if (feedback) {
        if (!readComments) throw new Error('Defect comment reader is unavailable');
        const comments = parseDefectComments(await readComments(item.id), item.id);
        if (comments) detail.description.body += `\n\n复测反馈（DevOps 评论）：\n${comments}`;
      }
      events.push(normalizeDefect(detail.item, config, detail.description,
        feedback ? undefined : selectRepository?.(detail.item.subject, detail.description.body)));
    }
    return { events, nextCursor: result.nextCursor };
  } };
}

export function parseDefectDetail(payload: unknown, expectedId: number, projectId: number): {
  item: z.infer<typeof defect>; description: { body: string; attachments: NormalizedEvent['attachments'] };
} {
  const response = z.object({ code: z.literal('200'), success: z.literal(true), data: defect }).parse(payload);
  if (response.data.id !== expectedId || response.data.businessProjectId !== projectId) throw new Error('Unexpected defect detail identity');
  if (response.data.description === null) throw new Error(`Defect ${expectedId} has no detail description`);
  return { item: response.data, description: parseDescription(response.data.description) };
}

export function parseDescription(serialized: string, readImages = true): { body: string; attachments: NormalizedEvent['attachments'] } {
  const tree: unknown = JSON.parse(serialized);
  const text: string[] = [];
  const attachments: NormalizedEvent['attachments'] = [];
  function visit(node: unknown): void {
    if (typeof node === 'string') { text.push(node); return; }
    if (!Array.isArray(node) || typeof node[0] !== 'string') throw new Error('Invalid defect description tree');
    const [tag, props, ...children] = node;
    if (tag === 'img' && readImages) {
      const source = z.object({ src: z.url() }).parse(props).src;
      const url = new URL(source);
      const match = /^\/api\/document\/fileRelation\/getRelatedFile\/([a-f0-9]{32})\/([a-f0-9]{32})$/.exec(url.pathname);
      if (url.origin !== 'https://devops.faw.cn' || url.search || url.hash || !match) throw new Error('Untrusted defect image reference');
      const sourceRef = `devops-file/${match[1]}/${match[2]}`;
      if (!attachments.some(item => item.sourceRef === sourceRef)) attachments.push({ id: match[2], kind: 'image', sourceRef, stableKey: defectAttachmentKey(sourceRef) });
    }
    for (const child of children) visit(child);
    if (tag === 'p') text.push('\n');
  }
  visit(tree);
  return { body: text.join('').split('\n').map(line => line.trim()).filter(Boolean).join('\n'), attachments };
}
