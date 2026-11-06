import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { answer, approvalDecision, reopenTaskCommand, routeReviewDecision } from '../interaction/model.js';
import { SqliteStore } from '../storage/sqlite/store.js';
import type { KernelCoordinator } from '../agent/kernel/model.js';

type Role = 'answer' | 'route' | 'approve' | 'reopen';
export type LocalApiOptions = { credentialFile: string; actorId: string; roles: readonly Role[];
  port?: number };

function credential(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' });
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw new Error('Credential file must be owned by the current user and mode 0600');
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < 64) throw new Error('Credential is too short');
  return token;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let input = '';
  for await (const chunk of request) {
    input += String(chunk);
    if (input.length > 65_536) throw new Error('Request body too large');
  }
  const value: unknown = JSON.parse(input || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  const data = value as Record<string, unknown>;
  if ('actor' in data || 'role' in data || 'roles' in data ||
      (data.value && typeof data.value === 'object' && ('actor' in data.value || 'role' in data.value)))
    throw new Error('Actor and role are assigned by the server');
  return data;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

export function startLocalApi(store: SqliteStore, coordinator: KernelCoordinator,
  options: LocalApiOptions): Promise<{ port: number; stop(): Promise<void> }> {
  const expected = createHash('sha256').update(credential(options.credentialFile)).digest();
  const server = createServer(async (request, response) => {
    const auth = request.headers.authorization;
    const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    const digest = createHash('sha256').update(provided).digest();
    if (!provided || !timingSafeEqual(digest, expected)) { json(response, 401, { error: 'Unauthorized' }); return; }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    try {
      if (request.method === 'GET' && path === '/inbox') {
        const events = store.db.prepare("SELECT id FROM source_event WHERE status='needs_human' ORDER BY received_at,id")
          .all().map(row => store.get(String(row.id)));
        const requests = store.db.prepare("SELECT payload_json FROM task_record WHERE kind IN ('question','approval_request') AND status='open' ORDER BY at,id")
          .all().map(row => JSON.parse(String(row.payload_json)));
        const tasks = store.db.prepare("SELECT payload_json FROM task WHERE state IN ('waiting_human','paused','blocked') ORDER BY updated_at,id")
          .all().map(row => JSON.parse(String(row.payload_json)));
        json(response, 200, { events, requests, tasks }); return;
      }
      if (request.method === 'GET' && /^\/tasks\/[^/]+$/.test(path)) {
        const taskId = decodeURIComponent(path.slice(7));
        const task = store.getTask(taskId);
        if (!task) { json(response, 404, { error: 'Task not found' }); return; }
        const runs = store.db.prepare('SELECT payload_json FROM run WHERE task_id=? ORDER BY created_at,id')
          .all(taskId).map(row => JSON.parse(String(row.payload_json)));
        const records = store.db.prepare('SELECT payload_json FROM task_record WHERE task_id=? ORDER BY at,id')
          .all(taskId).map(row => JSON.parse(String(row.payload_json)));
        json(response, 200, { task, runs, records }); return;
      }
      if (request.method === 'GET' && /^\/events\/[^/]+$/.test(path)) {
        const event = store.get(decodeURIComponent(path.slice(8)));
        json(response, event ? 200 : 404, event ?? { error: 'Event not found' }); return;
      }
      if (request.method !== 'POST') { json(response, 404, { error: 'Unknown endpoint' }); return; }
      const data = await body(request);
      const actor = { kind: 'human' as const, id: options.actorId };
      if (path === '/answers' && options.roles.includes('answer')) {
        await coordinator.onSignal({ kind: 'human_response', response: { kind: 'answer',
          value: answer.parse({ ...data, actor }) } });
        json(response, 200, { ok: true }); return;
      }
      if (path === '/approvals' && options.roles.includes('approve')) {
        await coordinator.onSignal({ kind: 'human_response', response: { kind: 'approval_decision',
          value: approvalDecision.parse({ ...data, actor, at: new Date().toISOString() }) } });
        json(response, 200, { ok: true }); return;
      }
      if (path === '/routes' && options.roles.includes('route')) {
        const value = routeReviewDecision.parse({ ...data, actor, at: new Date().toISOString() });
        await coordinator.onSignal({ kind: 'human_response', response: { kind: 'route_decision', value } });
        const routingData = store.get(value.eventId)?.routingData;
        const taskId = routingData && typeof routingData === 'object' && 'taskId' in routingData
          ? routingData.taskId : undefined;
        json(response, 200, { ok: true, taskId }); return;
      }
      if (path === '/tasks/reopen' && options.roles.includes('reopen')) {
        const result = coordinator.reopenTask(reopenTaskCommand.parse({ ...data, actor, at: new Date().toISOString() }));
        json(response, 200, { ok: true, ...result }); return;
      }
      json(response, 403, { error: 'Role not permitted' });
    } catch (error) {
      json(response, 409, { error: error instanceof Error ? error.message : 'Request rejected' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('No local API address')); return; }
      resolve({ port: address.port, stop: () => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())) });
    });
  });
}
