import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, extname } from 'node:path';
import { handleDashboard, type DashboardOptions } from './dashboard.js';
import { answer, approvalDecision, reopenTaskCommand, routeReviewDecision } from '../interaction/model.js';
import { SqliteStore } from '../storage/sqlite/store.js';
import type { KernelCoordinator } from '../agent/kernel/model.js';

type Role = 'answer' | 'route' | 'approve' | 'reopen' | 'submit' | 'command' | 'configure';
export type LocalApiOptions = { credentialFile: string; actorId: string; roles: readonly Role[];
  port?: number; dashboard?: DashboardOptions };

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
    const publicPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && (publicPath === '/' || publicPath === '/index.html' || /^\/assets\/[A-Za-z0-9._-]+$/.test(publicPath))) {
      const filename = publicPath === '/' ? 'index.html' : publicPath.slice(1);
      try {
        const bytes = readFileSync(resolve('web/dist', filename));
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[extname(filename)] ?? 'application/octet-stream';
        response.writeHead(200, { 'content-type': mime, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'" });
        response.end(bytes); return;
      } catch { json(response, 404, { error: 'Dashboard is not built' }); return; }
    }
    const auth = request.headers.authorization;
    const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    const digest = createHash('sha256').update(provided).digest();
    if (!provided || !timingSafeEqual(digest, expected)) { json(response, 401, { error: 'Unauthorized' }); return; }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    try {
      if (options.dashboard && await handleDashboard(request, response, store, coordinator, options.dashboard, options.roles)) return;
      if (request.method === 'GET' && path === '/inbox') {
        const events = store.db.prepare("SELECT id,status FROM source_event WHERE status='needs_human' ORDER BY received_at,id").all();
        const requests = store.db.prepare("SELECT id,task_id AS taskId,kind,status FROM task_record WHERE kind IN ('question','approval_request') AND status='open' ORDER BY at,id").all();
        const tasks = store.db.prepare("SELECT id,state FROM task WHERE state IN ('waiting_human','paused','blocked') ORDER BY updated_at,id").all();
        json(response, 200, { events, requests, tasks }); return;
      }
      if (request.method === 'GET' && (/^\/tasks\/[^/]+$/.test(path) || /^\/events\/[^/]+$/.test(path))) {
        json(response, 410, { error: 'Use the filtered /api view' }); return;
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
