import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export function qoderPatPath(): string {
  return resolve(process.env.AGENT_PLATFORM_QODER_PAT_PATH ??
    resolve(homedir(), '.config/agent-platform/qodercn.pat'));
}

function validatePat(token: string): string {
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error('Invalid QoderCN PAT');
  return token;
}

export function readQoderPat(): string | undefined {
  const path = qoderPatPath();
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return process.env.QODERCN_PERSONAL_ACCESS_TOKEN || undefined;
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())
    throw new Error('QoderCN PAT file must be owned by the current user and mode 0600');
  return validatePat(readFileSync(path, 'utf8'));
}

export function writeQoderPat(token: string): void {
  validatePat(token);
  const path = qoderPatPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, token, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
