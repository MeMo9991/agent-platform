import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { SqliteStore } from '../storage/sqlite/store.js';
import type { KernelCoordinator } from '../agent/kernel/model.js';
import type { AttachmentReader } from '../event/model.js';
import { createEventIngress } from '../event/ingress.js';
import { answer, approvalDecision, routeReviewDecision } from '../interaction/model.js';
import type { AgentRunner } from '../agent/worker/model.js';
import { completeTakeover, executeTaskCommand, type TakeoverEvidencePorts } from './task-command.js';
import { taskCommand } from '../interaction/task-command.js';
import { readSettings, saveSettings, settingsGroup, type SettingsPaths } from './settings.js';

const submit = z.object({ repoKey: z.string().min(1), body: z.string().trim().min(1).max(20_000),
  idempotencyKey: z.string().min(1).max(200), images: z.array(z.object({ data: z.string(), mimeType: z.string() })).max(2).default([]) }).strict();
const decision = z.object({ expectedVersion: z.number().int().positive(), value: z.record(z.string(), z.unknown()) }).strict();
const allowedImageTypes: Record<string, string> = { 'image/png': '89504e470d0a1a0a',
  'image/jpeg': 'ffd8ff', 'image/gif': '47494638', 'image/webp': '52494646' };

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage, maximum = 28 * 1024 * 1024): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > maximum) throw new Error('Request body too large');
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function page(url: URL): { limit: number; offset: number } {
  const limit = Number(url.searchParams.get('limit') ?? 25);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0)
    throw new Error('Invalid pagination');
  return { limit, offset };
}
function safeTask(store: SqliteStore, taskId: string) {
  const row = store.db.prepare('SELECT version FROM task WHERE id=?').get(taskId);
  const task = store.getTask(taskId);
  return row && task ? { id: task.id, title: task.title, scope: task.scope, repoKey: task.repoKey,
    originEventId: task.originEventId, state: task.state, iteration: task.iteration, priority: task.priority,
    owner: task.owner, parentTaskId: task.parentTaskId, createdAt: task.createdAt, updatedAt: task.updatedAt,
    mandate: task.mandate, version: Number(row.version) } : undefined;
}
function safeText(value: string): string {
  return value.slice(0, 8192)
    .replace(/file:\/\/\/[^\s"'`<>)]*/gi, '[本机路径]')
    .replace(/(^|[\s"'`(=:])\/(?!\/)[^\s"'`<>)]{2,}/gm, '$1[本机路径]')
    .replace(/\b(authorization|api[_-]?key|token|password)\s*[:=][^\r\n]*/gi, '$1=[已隐藏]');
}
function reviewedText(store: SqliteStore, targetKind: 'question' | 'result', targetId: string): string | undefined {
  const row = store.db.prepare(`SELECT payload_json FROM task_record WHERE kind='content_review'
    AND json_extract(payload_json,'$.targetKind')=? AND json_extract(payload_json,'$.targetId')=?
    ORDER BY at DESC,id DESC LIMIT 1`).get(targetKind, targetId);
  return row ? (JSON.parse(String(row.payload_json)) as { text: string }).text : undefined;
}
function evidenceFile(path: unknown, root: string, recordId: unknown, allowed: readonly string[]) {
  const reference = { recordId };
  if (typeof path !== 'string' || !path.startsWith('/')) return { ...reference, available: false };
  try {
    const canonical = realpathSync(path);
    const directory = realpathSync(root);
    const info = lstatSync(path);
    if (!allowed.some(name => canonical.startsWith(`${resolve(directory, name)}/`)) ||
        !info.isFile() || (info.mode & 0o077) !== 0 ||
        info.uid !== process.getuid?.()) return { ...reference, available: false };
    if (info.size > 2 * 1024 * 1024) return { ...reference, available: true, bytes: info.size, truncated: true };
    const bytes = readFileSync(path);
    if (bytes.length > 2 * 1024 * 1024) return { ...reference, available: true, bytes: bytes.length, truncated: true };
    return { ...reference, available: true, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { return { ...reference, available: false }; }
}
function safeRun(run: Record<string, unknown>, store: SqliteStore) {
  const { workspaceRef, resultRef, execution, ...publicRun } = run;
  return { ...publicRun, hasResult: Boolean(resultRef),
    conclusion: resultRef ? reviewedText(store, 'result', String(run.id)) : undefined };
}
function safeRecord(record: Record<string, unknown>, evidenceRoot: string, store: SqliteStore) {
  const selected: Record<string, unknown> = {};
  for (const key of ['id', 'taskId', 'runId', 'eventId', 'kind', 'at', 'status', 'content',
    'from', 'to', 'decision', 'subjectSha', 'questionId', 'policyVersion', 'reviewedSha',
    'baseSha', 'commitSha', 'developmentRecordId', 'codeChange', 'postCheckVerified', 'exitCode', 'terminationConfirmed',
    'timeoutMs', 'startedAt', 'endedAt'])
    if (record[key] !== undefined) selected[key] = key === 'content' && typeof record[key] === 'string'
      ? safeText(record[key] as string) : record[key];
  if (record.kind === 'approval_request' && record.request && typeof record.request === 'object') {
    const request = record.request as Record<string, unknown>;
    const proposed = request.proposedMandate as Record<string, unknown> | undefined;
    selected.request = { id: request.id, kind: request.kind, sourceSha: request.sourceSha,
      proposedMandate: proposed ? { allowedActions: proposed.allowedActions } : undefined };
  }
  if (record.kind === 'check') {
    selected.result = record.result;
    selected.log = evidenceFile(record.logRef, evidenceRoot, record.id, ['check-logs', 'sandbox-profiles']);
  }
  if (record.kind === 'development') selected.diff = evidenceFile(record.diffRef, evidenceRoot, record.id, ['evidence']);
  if (typeof record.summary === 'string') selected.summary = record.kind === 'human_result'
    ? safeText(record.summary) : 'Agent 记录待审查';
  if (record.kind === 'question') selected.prompt = reviewedText(store, 'question', String(record.id));
  if (record.kind === 'content_review') {
    selected.targetKind = record.targetKind;
    selected.targetId = record.targetId;
    selected.summary = record.text;
    selected.reviewer = (record.actor as { id?: string } | undefined)?.id;
  }
  return selected;
}
function linkedTaskId(store: SqliteStore, eventId: string): string | undefined {
  const row = store.db.prepare(`SELECT record.task_id FROM task_record AS record
    JOIN task ON task.id=record.task_id
    WHERE record.event_id=? AND record.kind='event_link' AND record.status<>'handback'
      AND json_extract(record.payload_json,'$.mode')='handle'
    ORDER BY CASE WHEN record.status IN ('pending','delivered','uncertain') THEN 0 ELSE 1 END,
      record.at DESC, record.id DESC LIMIT 1`).get(eventId);
  return row ? String(row.task_id) : undefined;
}
function safeEvent(store: SqliteStore, id: string) {
  const event = store.get(id);
  if (!event) return undefined;
  const { metaData, routingData, attachments, ...publicEvent } = event;
  const routing = routingData && typeof routingData === 'object' ? routingData as Record<string, unknown> : {};
  const route = routing.decision && typeof routing.decision === 'object' ? routing.decision as Record<string, unknown> : routing;
  return { ...publicEvent, taskId: linkedTaskId(store, id), attachments: attachments.map(item => ({ id: item.id, kind: item.kind,
    mimeType: item.mimeType, imageUrl: `/api/events/${encodeURIComponent(id)}/images/${encodeURIComponent(item.id)}` })),
    routing: { reason: typeof route.reason === 'string' ? route.reason : undefined,
      candidates: Array.isArray(route.candidates) ? route.candidates : [] } };
}
function checkVersion(store: SqliteStore, taskId: string, expectedVersion: number): void {
  if (safeTask(store, taskId)?.version !== expectedVersion) throw new Error('Task version changed; reload before deciding');
}
function imageBytes(data: string, mimeType: string): Buffer {
  if (!allowedImageTypes[mimeType] || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw new Error('Unsupported image');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024 || detectImageType(bytes) !== mimeType)
    throw new Error('Invalid image contents or size');
  return bytes;
}
function detectImageType(bytes: Buffer): string | undefined {
  const prefix = bytes.toString('hex', 0, 8);
  if (prefix.startsWith(allowedImageTypes['image/png']!)) return 'image/png';
  if (prefix.startsWith(allowedImageTypes['image/jpeg']!)) return 'image/jpeg';
  if (prefix.startsWith(allowedImageTypes['image/gif']!)) return 'image/gif';
  if (prefix.startsWith(allowedImageTypes['image/webp']!) && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return undefined;
}
function protectedDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() ||
      !statSync(realpathSync(path)).isDirectory())
    throw new Error('Manual image directory must be private and owned by the service user');
  return path;
}

export type DashboardOptions = { actorId: string; repoKeys: readonly string[];
  imageDirectory: string; attachmentReaders: Readonly<Record<string, AttachmentReader>>;
  runners?: Readonly<Record<string, AgentRunner | undefined>>; workerCapacity?: number;
  evidenceRoot?: string; takeoverEvidence?: TakeoverEvidencePorts; settingsPaths?: SettingsPaths };

export async function handleDashboard(request: IncomingMessage, response: ServerResponse, store: SqliteStore,
  coordinator: KernelCoordinator, options: DashboardOptions, roles: readonly string[]): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (!path.startsWith('/api/')) return false;
  try {
    if (request.method === 'GET' && path === '/api/config') {
      send(response, 200, { actorId: options.actorId, repoKeys: options.repoKeys, roles }); return true;
    }
    if (path === '/api/settings' && request.method === 'GET') {
      if (!roles.includes('configure') || !options.settingsPaths) throw new Error('Configure role required');
      send(response, 200, readSettings(options.settingsPaths)); return true;
    }
    const settingMatch = /^\/api\/settings\/([^/]+)$/.exec(path);
    if (settingMatch && request.method === 'PUT') {
      if (!roles.includes('configure') || !options.settingsPaths) throw new Error('Configure role required');
      const group = settingsGroup.parse(settingMatch[1]);
      const input = z.object({ expectedRevision: z.string().length(64), value: z.unknown() }).strict()
        .parse(await readBody(request, 1024 * 1024));
      send(response, 200, saveSettings(options.settingsPaths, group, input.expectedRevision, input.value)); return true;
    }
    if (request.method === 'GET' && path === '/api/overview') {
      const count = (sql: string) => Number(store.db.prepare(sql).get()?.n ?? 0);
      send(response, 200, { pendingEvents: count("SELECT count(*) AS n FROM source_event WHERE status IN ('pending','routing')"),
        humanEvents: count("SELECT count(*) AS n FROM source_event WHERE status='needs_human'"),
        openRequests: count("SELECT count(*) AS n FROM task_record WHERE kind IN ('question','approval_request') AND status='open'"),
        failedTasks: count("SELECT count(*) AS n FROM task WHERE state IN ('failed','blocked','paused')"),
        runningWorkers: count("SELECT count(*) AS n FROM run WHERE status='running'"),
        queuedRuns: count("SELECT count(*) AS n FROM run WHERE status='queued'"),
        enabledSources: count('SELECT count(*) AS n FROM event_source WHERE enabled=1'),
        workerCapacity: options.workerCapacity ?? null }); return true;
    }
    if (request.method === 'GET' && path === '/api/inbox') {
      const { limit, offset } = page(url);
      const events = store.db.prepare("SELECT id FROM source_event WHERE status='needs_human' ORDER BY received_at,id LIMIT ? OFFSET ?")
        .all(limit, offset).map(row => safeEvent(store, String(row.id)));
      const requests = store.db.prepare("SELECT payload_json FROM task_record WHERE kind IN ('question','approval_request') AND status='open' ORDER BY at,id LIMIT ? OFFSET ?")
        .all(limit, offset).map(row => safeRecord(JSON.parse(String(row.payload_json)), options.evidenceRoot ?? '', store));
      const tasks = store.db.prepare("SELECT id FROM task WHERE state IN ('failed','blocked','paused','waiting_human') ORDER BY updated_at DESC,id LIMIT ? OFFSET ?")
        .all(limit, offset).map(row => safeTask(store, String(row.id)));
      send(response, 200, { events, requests, tasks }); return true;
    }
    if (request.method === 'GET' && path === '/api/tasks') {
      const { limit, offset } = page(url);
      const clauses: string[] = [];
      const args: string[] = [];
      for (const [query, column] of [['state', 'state'], ['repoKey', 'repo_key']] as const) {
        const value = url.searchParams.get(query);
        if (value) { clauses.push(`${column}=?`); args.push(value); }
      }
      if (url.searchParams.get('sourceId')) {
        clauses.push('origin_event_id IN (SELECT id FROM source_event WHERE source_id=?)');
        args.push(url.searchParams.get('sourceId')!);
      }
      for (const [query, operator] of [['from', '>='], ['to', '<=']] as const) {
        const value = url.searchParams.get(query);
        if (value) { if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid date filter');
          clauses.push(`created_at${operator}?`); args.push(value); }
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const total = Number(store.db.prepare(`SELECT count(*) AS n FROM task${where}`).get(...args)?.n ?? 0);
      const items = store.db.prepare(`SELECT id FROM task${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`)
        .all(...args, limit, offset).map(row => safeTask(store, String(row.id)));
      send(response, 200, { items, total, limit, offset }); return true;
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (request.method === 'DELETE' && taskMatch) {
      if (!roles.includes('command')) { send(response, 403, { error: 'Command role required' }); return true; }
      const deleted = store.deleteTask(decodeURIComponent(taskMatch[1]!));
      send(response, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'Task not found' }); return true;
    }
    if (request.method === 'GET' && taskMatch) {
      const id = decodeURIComponent(taskMatch[1]!);
      const task = safeTask(store, id);
      if (!task) { send(response, 404, { error: 'Task not found' }); return true; }
      const rawRuns = store.db.prepare('SELECT payload_json FROM run WHERE task_id=? ORDER BY created_at,id').all(id)
        .map(row => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
      const runs = rawRuns.map(run => safeRun(run, store));
      const records = store.db.prepare('SELECT payload_json FROM task_record WHERE task_id=? ORDER BY at,id').all(id)
        .map(row => safeRecord(JSON.parse(String(row.payload_json)), options.evidenceRoot ?? '', store));
      const events = store.db.prepare('SELECT DISTINCT event_id FROM task_record WHERE task_id=? AND event_id IS NOT NULL UNION SELECT origin_event_id FROM task WHERE id=? AND origin_event_id IS NOT NULL')
        .all(id, id).map(row => safeEvent(store, String(row.event_id ?? row.origin_event_id)));
      send(response, 200, { task, runs, records, events }); return true;
    }
    const eventMatch = /^\/api\/events\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && eventMatch) {
      const event = safeEvent(store, decodeURIComponent(eventMatch[1]!));
      send(response, event ? 200 : 404, event ?? { error: 'Event not found' }); return true;
    }
    const reviewMatch = /^\/api\/tasks\/([^/]+)\/content-reviews$/.exec(path);
    if (request.method === 'POST' && reviewMatch) {
      const taskId = decodeURIComponent(reviewMatch[1]!);
      const input = z.object({ expectedVersion: z.number().int().positive(), targetKind: z.enum(['question', 'result']),
        targetId: z.string().min(1), text: z.string().trim().min(1).max(8192),
        idempotencyKey: z.string().min(1) }).strict().parse(await readBody(request, 16_384));
      if (!roles.includes(input.targetKind === 'question' ? 'answer' : 'command')) throw new Error('Role not permitted');
      const duplicate = store.transaction(() => {
        checkVersion(store, taskId, input.expectedVersion);
        if (input.targetKind === 'question') {
          const target = store.getRecord(input.targetId);
          if (!target || target.taskId !== taskId || target.kind !== 'question' || target.status !== 'open')
            throw new Error('Review target is unavailable');
        } else {
          const target = store.getRun(input.targetId);
          if (!target || target.taskId !== taskId || !target.resultRef) throw new Error('Review target is unavailable');
        }
        const existing = store.db.prepare(`SELECT payload_json FROM task_record WHERE kind='content_review'
          AND task_id=? AND json_extract(payload_json,'$.targetKind')=?
          AND json_extract(payload_json,'$.targetId')=? LIMIT 1`).get(taskId, input.targetKind, input.targetId);
        if (existing) {
          const prior = JSON.parse(String(existing.payload_json)) as { text: string; idempotencyKey: string; actor: { id: string } };
          if (prior.idempotencyKey === input.idempotencyKey && prior.text === input.text && prior.actor.id === options.actorId) return true;
          throw new Error('Target already has a published review');
        }
        store.saveRecord({ id: randomUUID(), taskId, kind: 'content_review', targetKind: input.targetKind,
          targetId: input.targetId, text: input.text, status: 'published',
          actor: { kind: 'human', id: options.actorId }, idempotencyKey: input.idempotencyKey,
          at: new Date().toISOString() });
        return false;
      });
      send(response, 200, { ok: true, duplicate }); return true;
    }
    const routeMatch = /^\/api\/events\/([^/]+)\/routes$/.exec(path);
    if (request.method === 'POST' && routeMatch) {
      if (!roles.includes('route')) throw new Error('Route role required');
      const eventId = decodeURIComponent(routeMatch[1]!);
      const value = routeReviewDecision.parse({ ...(await readBody(request, 65_536) as Record<string, unknown>),
        eventId, actor: { kind: 'human', id: options.actorId }, at: new Date().toISOString() });
      await coordinator.onSignal({ kind: 'human_response', response: { kind: 'route_decision', value } });
      const event = safeEvent(store, eventId);
      send(response, 200, { ok: true, event, taskId: event?.taskId });
      return true;
    }
    const imageMatch = /^\/api\/events\/([^/]+)\/images\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && imageMatch) {
      const event = store.get(decodeURIComponent(imageMatch[1]!));
      const ref = event?.attachments.find(item => item.id === decodeURIComponent(imageMatch[2]!));
      const reader = event && options.attachmentReaders[event.sourceId];
      if (!event || !ref || !reader || ref.kind !== 'image')
        throw new Error('Image unavailable');
      const stream = await reader.open(event.sourceId, ref);
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of stream) { size += chunk.byteLength; if (size > 10 * 1024 * 1024) throw new Error('Image too large'); parts.push(chunk); }
      const bytes = Buffer.concat(parts);
      const mimeType = detectImageType(bytes);
      if (!mimeType) throw new Error('Image format unsupported');
      response.writeHead(200, { 'content-type': mimeType,
        'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      response.end(bytes); return true;
    }
    if (request.method === 'POST' && path === '/api/events') {
      if (!roles.includes('submit')) throw new Error('Submission role required');
      const input = submit.parse(await readBody(request));
      if (!options.repoKeys.includes(input.repoKey)) throw new Error('Repository is not authorized');
      const sourceId = `manual:${input.repoKey}`;
      const directory = protectedDirectory(resolve(options.imageDirectory));
      const created: string[] = [];
      try {
        const images = input.images.map(image => ({ bytes: imageBytes(image.data, image.mimeType), mimeType: image.mimeType }));
        const digest = createHash('sha256').update(JSON.stringify([input.repoKey, input.body,
          images.map(image => [image.mimeType, createHash('sha256').update(image.bytes).digest('hex')])])).digest('hex');
        const attachments = images.map(image => {
          const bytes = image.bytes;
          const id = randomUUID();
          const path = resolve(directory, id);
          writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
          created.push(path);
          return { id, kind: 'image' as const, sourceRef: `manual/${id}`, mimeType: image.mimeType };
        });
        const result = await createEventIngress(store, { [sourceId]: ['contentDigest'] }).accept({ sourceId,
          externalId: `${options.actorId}:${input.idempotencyKey}`, revision: '1', kind: 'manual_task',
          title: input.body.split('\n')[0]!.slice(0, 200), body: input.body, repoKey: input.repoKey,
          attachments, metaData: { contentDigest: digest } });
        if (result.duplicate && store.get(result.eventId)?.metaData.contentDigest !== digest)
          throw new Error('Idempotency key belongs to another submission');
        if (result.duplicate) for (const path of created) rmSync(path, { force: true });
        const event = store.get(result.eventId)!;
        send(response, 202, { eventId: result.eventId, duplicate: result.duplicate, status: event.status,
          taskId: linkedTaskId(store, result.eventId) });
      } catch (error) { for (const path of created) rmSync(path, { force: true }); throw error; }
      return true;
    }
    const actionMatch = /^\/api\/tasks\/([^/]+)\/(answers|approvals)$/.exec(path);
    if (request.method === 'POST' && actionMatch) {
      const taskId = decodeURIComponent(actionMatch[1]!);
      const input = decision.parse(await readBody(request, 65_536));
      const role = actionMatch[2] === 'answers' ? 'answer' : 'approve';
      if (!roles.includes(role)) throw new Error('Role not permitted');
      const actor = { kind: 'human' as const, id: options.actorId };
      const key = typeof input.value.idempotencyKey === 'string' ? input.value.idempotencyKey : undefined;
      if (key) {
        const prior = store.db.prepare('SELECT id FROM task_record WHERE kind=? AND idempotency_key=?')
          .get(actionMatch[2] === 'answers' ? 'answer' : 'approval', key);
        const record = prior ? store.getRecord(String(prior.id)) : undefined;
        if (record && record.taskId === taskId && 'actor' in record && record.actor.id === actor.id &&
            (record.kind === 'answer' && record.questionId === input.value.questionId && record.content === input.value.content ||
             record.kind === 'approval' && record.requestId === input.value.requestId && record.decision === input.value.decision)) {
          send(response, 200, { ok: true, duplicate: true, task: safeTask(store, taskId) }); return true;
        }
        if (record) throw new Error('Idempotency key belongs to another decision');
      }
      checkVersion(store, taskId, input.expectedVersion);
        if (actionMatch[2] === 'answers') await coordinator.onSignal({ kind: 'human_response', taskId,
          response: { kind: 'answer', value: answer.parse({ ...input.value, actor }) } });
        else await coordinator.onSignal({ kind: 'human_response', taskId,
          response: { kind: 'approval_decision', value: approvalDecision.parse({ ...input.value, actor, at: new Date().toISOString() }) } });
      send(response, 200, { ok: true, task: safeTask(store, taskId) }); return true;
    }
    const commandMatch = /^\/api\/tasks\/([^/]+)\/commands$/.exec(path);
    if (request.method === 'POST' && commandMatch) {
      if (!roles.includes('command')) throw new Error('Command role required');
      const input = taskCommand.parse({ ...(await readBody(request, 65_536) as Record<string, unknown>),
        taskId: decodeURIComponent(commandMatch[1]!) });
      if (input.kind === 'split' || input.kind === 'takeover_result') throw new Error('Use the dedicated command endpoint');
      const result = await executeTaskCommand(store, options.runners ?? {}, options.actorId,
        input);
      send(response, 200, { ok: true, ...result }); return true;
    }
    const takeoverMatch = /^\/api\/tasks\/([^/]+)\/takeover-result$/.exec(path);
    if (request.method === 'POST' && takeoverMatch) {
      if (!roles.includes('command')) throw new Error('Command role required');
      const input = taskCommand.parse({ ...(await readBody(request, 65_536) as Record<string, unknown>),
        kind: 'takeover_result', taskId: decodeURIComponent(takeoverMatch[1]!) });
      if (input.kind !== 'takeover_result') throw new Error('Invalid takeover command');
      const result = await completeTakeover(store, options.actorId, input, options.takeoverEvidence);
      send(response, 200, { ok: true, ...result }); return true;
    }
    const splitMatch = /^\/api\/tasks\/([^/]+)\/split$/.exec(path);
    if (request.method === 'POST' && splitMatch) {
      if (!roles.includes('command')) throw new Error('Command role required');
      const input = taskCommand.parse({ ...(await readBody(request, 65_536) as Record<string, unknown>),
        kind: 'split', taskId: decodeURIComponent(splitMatch[1]!) });
      if (input.kind !== 'split') throw new Error('Invalid split command');
      const taskId = decodeURIComponent(splitMatch[1]!);
      const parent = store.getTask(taskId);
      if (!parent) throw new Error('Task not found');
      if (!options.repoKeys.includes(parent.repoKey)) throw new Error('Repository is not authorized');
      const sourceId = `manual:${parent.repoKey}`;
      const digest = createHash('sha256').update(JSON.stringify([taskId, input.description])).digest('hex');
      const existing = store.db.prepare('SELECT id FROM source_event WHERE source_id=? AND external_id=? AND revision=?')
        .get(sourceId, `${options.actorId}:split:${input.idempotencyKey}`, '1');
      if (existing) {
        const eventId = String(existing.id);
        if (store.get(eventId)?.metaData.contentDigest !== digest) throw new Error('Idempotency key belongs to another split');
        send(response, 202, { eventId, duplicate: true, status: store.get(eventId)?.status }); return true;
      }
      checkVersion(store, taskId, input.expectedVersion);
      const result = await createEventIngress(store, { [sourceId]: ['contentDigest'] }).accept({ sourceId,
        externalId: `${options.actorId}:split:${input.idempotencyKey}`, revision: '1', kind: 'manual_task',
        title: input.description.split('\n')[0]!.slice(0, 200), body: input.description,
        repoKey: parent.repoKey, attachments: [], metaData: { contentDigest: digest } });
      if (result.duplicate && store.get(result.eventId)?.metaData.contentDigest !== digest)
        throw new Error('Idempotency key belongs to another split');
      if (!result.duplicate) store.db.prepare("UPDATE source_event SET routing_data=? WHERE id=? AND status='pending' AND routing_data IS NULL")
        .run(JSON.stringify({ excludedTaskId: taskId }), result.eventId);
      send(response, 202, { eventId: result.eventId, duplicate: result.duplicate, status: store.get(result.eventId)?.status });
      return true;
    }
    send(response, 404, { error: 'Unknown endpoint' }); return true;
  } catch (error) {
    send(response, error instanceof z.ZodError ? 400 : 409,
      { error: error instanceof Error ? error.message : 'Request rejected' });
    return true;
  }
}
