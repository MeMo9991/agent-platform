import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NormalizedEvent, PollingSource } from '../../model.js';

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
export const defectMetadataFields = ['businessProjectId', 'statusId', 'descriptionId', 'priority', 'environment', 'gmtCreated', 'gmtModified', 'repositorySelection'] as const;
export type DefectSourceConfig = { sourceId: string; businessProjectId: number; pageSize?: number };
export type RepositorySelection = { repoKey: string; reason: 'repository-name' | 'file-name' | 'default' };

export function normalizeDefect(raw: z.infer<typeof defect>, config: DefectSourceConfig,
  detail: { body: string; attachments: NormalizedEvent['attachments'] }, selection?: RepositorySelection): NormalizedEvent {
  if (raw.businessProjectId !== config.businessProjectId) throw new Error(`Unexpected project for defect ${raw.id}`);
  const revisionFacts = [raw.gmtModified, raw.subject, detail.body, detail.attachments, raw.descriptionId, raw.statusId, raw.priority, raw.environment];
  return {
    sourceId: config.sourceId, externalId: String(raw.id), objectKey: String(raw.id), kind: 'bug',
    revision: createHash('sha256').update(JSON.stringify(revisionFacts)).digest('hex'),
    title: raw.subject, body: detail.body, repoKey: selection?.repoKey,
    attachments: detail.attachments,
    metaData: { businessProjectId: raw.businessProjectId, statusId: raw.statusId, descriptionId: raw.descriptionId,
      priority: raw.priority, environment: raw.environment, gmtCreated: raw.gmtCreated, gmtModified: raw.gmtModified,
      ...(selection ? { repositorySelection: selection.reason } : {}) },
  };
}

export function parseDefectPage(payload: unknown, config: DefectSourceConfig, expectedPage: number): { items: z.infer<typeof defect>[]; nextCursor?: string } {
  const result = defectPage.parse(payload);
  if (result.code !== '200' || result.data.pageNum !== expectedPage || result.data.pageSize !== (config.pageSize ?? 10))
    throw new Error('Unexpected defect list response');
  return { items: result.data.list,
    ...(expectedPage * result.data.pageSize < result.data.total ? { nextCursor: String(expectedPage + 1) } : {}) };
}

export function createDefectSource(config: DefectSourceConfig, readPage: (page: number) => Promise<unknown>,
  readDetail: (id: number) => Promise<unknown>,
  selectRepository?: (title: string, body: string) => RepositorySelection | undefined): PollingSource {
  return { async read(cursor) {
    const page = cursor === undefined ? 1 : Number(cursor);
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid page cursor');
    const result = parseDefectPage(await readPage(page), config, page);
    const events: NormalizedEvent[] = [];
    for (const item of result.items) {
      const detail = parseDefectDetail(await readDetail(item.id), item.id, config.businessProjectId);
      events.push(normalizeDefect(detail.item, config, detail.description,
        selectRepository?.(detail.item.subject, detail.description.body)));
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

export function parseDescription(serialized: string): { body: string; attachments: NormalizedEvent['attachments'] } {
  const tree: unknown = JSON.parse(serialized);
  const text: string[] = [];
  const attachments: NormalizedEvent['attachments'] = [];
  function visit(node: unknown): void {
    if (typeof node === 'string') { text.push(node); return; }
    if (!Array.isArray(node) || typeof node[0] !== 'string') throw new Error('Invalid defect description tree');
    const [tag, props, ...children] = node;
    if (tag === 'img') {
      const source = z.object({ src: z.url() }).parse(props).src;
      const url = new URL(source);
      const match = /^\/api\/document\/fileRelation\/getRelatedFile\/([a-f0-9]{32})\/([a-f0-9]{32})$/.exec(url.pathname);
      if (url.origin !== 'https://devops.faw.cn' || url.search || url.hash || !match) throw new Error('Untrusted defect image reference');
      const sourceRef = `devops-file/${match[1]}/${match[2]}`;
      if (!attachments.some(item => item.sourceRef === sourceRef)) attachments.push({ id: match[2], kind: 'image', sourceRef });
    }
    for (const child of children) visit(child);
    if (tag === 'p') text.push('\n');
  }
  visit(tree);
  return { body: text.join('').split('\n').map(line => line.trim()).filter(Boolean).join('\n'), attachments };
}
