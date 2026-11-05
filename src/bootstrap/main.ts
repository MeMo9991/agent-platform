import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startConfiguredSchedules } from './start-schedules.js';

const providerPath = process.env.AGENT_PLATFORM_AUTH_PROVIDER;
if (!providerPath) throw new Error('AGENT_PLATFORM_AUTH_PROVIDER must name a trusted authorization provider module');
const provider: unknown = await import(pathToFileURL(resolve(providerPath)).href);
const authorizationHeaders = (provider as { authorizationHeaders?: unknown }).authorizationHeaders;
if (typeof authorizationHeaders !== 'function') throw new Error('Authorization provider must export authorizationHeaders()');

const runtime = startConfiguredSchedules({
  platform: process.env.AGENT_PLATFORM_CONFIG ?? 'config/platform.json',
  schedules: process.env.AGENT_PLATFORM_SCHEDULES ?? 'config/schedules.json',
  database: process.env.AGENT_PLATFORM_DATABASE ?? 'agent-platform.sqlite3',
}, authorizationHeaders as () => Promise<HeadersInit>,
  (taskId, error) => { console.error(`Scheduled task ${taskId} failed`, error); });

const stop = () => { void runtime.stop().catch(error => { console.error('Shutdown failed', error); process.exitCode = 1; }); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
