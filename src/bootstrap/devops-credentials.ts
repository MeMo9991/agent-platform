import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

export const devopsCredentials = z.object({
  authorization: z.string().min(1),
  cookie: z.string().min(1),
}).strict();

export type DevopsCredentials = z.infer<typeof devopsCredentials>;

const defaultPath = resolve(homedir(), '.config/agent-platform/devops-credentials.json');

export function getCredentialsPath(): string {
  return process.env.DEVOPS_CREDENTIALS_PATH ?? defaultPath;
}

export function readCredentials(): DevopsCredentials | undefined {
  const path = getCredentialsPath();
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return undefined;
  return devopsCredentials.parse(JSON.parse(content));
}

export function writeCredentials(credentials: DevopsCredentials): void {
  const path = getCredentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function credentialsExist(): boolean {
  return existsSync(getCredentialsPath());
}

export async function authorizationHeaders(): Promise<HeadersInit> {
  const credentials = readCredentials();
  if (!credentials) throw new Error('DevOps credentials not configured. Set them in the settings page.');
  return {
    Authorization: credentials.authorization,
    Cookie: credentials.cookie,
  };
}
