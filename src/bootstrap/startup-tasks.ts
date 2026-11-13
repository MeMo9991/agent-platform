import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlatformConfig } from './config.js';
import type { SqliteStore } from '../storage/sqlite/store.js';
import { pruneWorkspaces, type PruneWorkspacesResult } from './prune-workspaces.js';

const exec = promisify(execFile);

export interface AgentLinkStatus {
  kind: string;
  linked: boolean;
  detail: string;
  checkedAt: string;
}

export interface StartupResult {
  prune?: PruneWorkspacesResult;
  agents: AgentLinkStatus[];
}

type StatusRunner = (path: string, timeoutMs: number) => Promise<string>;

async function runQoderStatus(path: string, timeoutMs: number): Promise<string> {
  const result = await exec(path, ['status'], { timeout: timeoutMs, maxBuffer: 64 * 1024,
    env: process.env, windowsHide: true });
  return result.stdout;
}

export async function checkAgentLinks(input: {
  agents: readonly { kind: string; enabled: boolean }[];
  qoderPath: string;
  timeoutMs?: number;
  statusRunner?: StatusRunner;
}): Promise<AgentLinkStatus[]> {
  const checkedAt = new Date().toISOString();
  const statuses: AgentLinkStatus[] = [];
  for (const agent of input.agents.filter(item => item.enabled)) {
    if (agent.kind !== 'qoder') {
      statuses.push({ kind: agent.kind, linked: false, detail: '暂不支持该智能体的链接检查', checkedAt });
      continue;
    }
    try {
      const output = await (input.statusRunner ?? runQoderStatus)(input.qoderPath,
        input.timeoutMs ?? 10_000);
      const linked = /^Username:\s*\S+/m.test(output) && !/not logged in|未登录/i.test(output);
      statuses.push({ kind: 'qoder', linked,
        detail: linked ? '已连接' : 'Qoder CLI 未登录或无法确认账号', checkedAt });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const detail = code === 'ENOENT' ? 'Qoder CLI 不存在或不可执行'
        : (error as { killed?: boolean }).killed ? 'Qoder 连接检查超时'
          : 'Qoder 连接检查失败';
      statuses.push({ kind: 'qoder', linked: false, detail, checkedAt });
    }
  }
  return statuses;
}

export async function runStartupTasks(input: {
  platform: PlatformConfig;
  store: SqliteStore;
  runtimeRoot: string;
  qoderPath: string;
  retentionMs: number;
  orphanGraceMs: number;
  statusRunner?: StatusRunner;
  onError?: (task: string, error: unknown) => void;
}): Promise<StartupResult> {
  let prune: PruneWorkspacesResult | undefined;
  try {
    prune = await pruneWorkspaces({ store: input.store, runtimeRoot: input.runtimeRoot,
      retentionMs: input.retentionMs, orphanGraceMs: input.orphanGraceMs,
      onError: (path, error) => input.onError?.(`prune:${path}`, error) });
  } catch (error) {
    input.onError?.('prune', error);
  }
  const agents = await checkAgentLinks({ agents: input.platform.agents, qoderPath: input.qoderPath,
    ...(input.statusRunner ? { statusRunner: input.statusRunner } : {}) });
  return { ...(prune ? { prune } : {}), agents };
}
