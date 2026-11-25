import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const headerValue = z.string().trim().regex(/^[\t\x20-\x7e\x80-\xff]+$/, 'Invalid HTTP header value');
export const devopsCredentials = z.strictObject({ authorization: headerValue, cookie: headerValue });
type DevopsCredentials = z.infer<typeof devopsCredentials>;

function credentialsPath(): string {
  return resolve(process.env.DEVOPS_CREDENTIALS_PATH ?? resolve(homedir(), '.config/agent-platform/devops-credentials.json'));
}

function privateFile(path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw new Error('DevOps credential file must be owned by the current user and mode 0600');
  return true;
}

export function readCredentials(): DevopsCredentials | undefined {
  const path = credentialsPath();
  if (!privateFile(path)) return undefined;
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return undefined;
  try { return devopsCredentials.parse(JSON.parse(content)); }
  catch { throw new Error('Invalid DevOps credential file'); }
}

export function writeCredentials(credentials: DevopsCredentials): void {
  const validated = devopsCredentials.parse(credentials);
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  privateFile(path);
  const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export async function authorizationHeaders(): Promise<HeadersInit> {
  const credentials = readCredentials();
  if (!credentials) throw new Error('DevOps credentials not configured. Set them in the settings page.');
  return { Authorization: credentials.authorization, Cookie: credentials.cookie };
}
