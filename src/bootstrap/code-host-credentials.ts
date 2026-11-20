import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const tokens = z.record(z.string(), z.string().regex(/^[\x21-\x7e]+$/));
const path = () => resolve(process.env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH ??
  resolve(homedir(), '.config/agent-platform/code-host-credentials.json'));

export function readCodeHostToken(repoKey: string): string | undefined {
  const file = path();
  if (!existsSync(file)) return undefined;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw new Error('Code-host credential file must be owned by the current user and mode 0600');
  return tokens.parse(JSON.parse(readFileSync(file, 'utf8')))[repoKey];
}

export const readCodeHostGroupToken = (projectKey: string): string | undefined =>
  readCodeHostToken(`group:${projectKey}`);

export const writeCodeHostGroupToken = (projectKey: string, token: string): void =>
  writeCodeHostToken(`group:${projectKey}`, token);

export function writeCodeHostToken(repoKey: string, token: string): void {
  tokens.parse({ [repoKey]: token });
  const file = path();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) readCodeHostToken(repoKey);
  const current = existsSync(file) ? tokens.parse(JSON.parse(readFileSync(file, 'utf8'))) : {};
  const temporary = resolve(dirname(file), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ ...current, [repoKey]: token }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
