import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function hasAcl(path: string): boolean {
  // macOS ACL grants are not reflected in stat.mode.
  return /^\s*\d+:/m.test(execFileSync('/bin/ls', ['-lde', path], { encoding: 'utf8' }));
}

export async function acquireInstanceLock(databasePath: string, onLost: () => void) {
  const database = resolve(databasePath);
  await mkdir(dirname(database), { recursive: true, mode: 0o700 });
  const canonical = await realpath(database).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    try {
      if ((await lstat(database)).isSymbolicLink())
        throw new Error('Database path is a dangling symbolic link');
    } catch (entryError) {
      if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError;
    }
    return join(await realpath(dirname(database)), basename(database));
  });
  const lockPath = `${canonical}.lock`;
  const directory = await stat(dirname(lockPath));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0 ||
      hasAcl(dirname(lockPath)))
    throw new Error('Database lock directory must be owned by the service account and accessible only to it');
  for (let parent = dirname(dirname(lockPath)); parent !== dirname(parent); parent = dirname(parent)) {
    const entry = await stat(parent);
    if (hasAcl(parent) || ((entry.mode & 0o022) !== 0 && ((entry.mode & 0o1000) === 0 ||
        (entry.uid !== 0 && entry.uid !== directory.uid))))
      throw new Error('Database lock parent directory can be replaced by another account');
  }
  try {
    const existing = await lstat(lockPath);
    if (!existing.isFile() || existing.uid !== directory.uid)
      throw new Error('Database lock file is not a regular service-owned file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const child = spawn('/usr/bin/lockf', ['-k', '-t', '0', lockPath, '/bin/cat'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin!.on('error', () => { /* lockf reports failure through its exit status */ });
  const challenge = `${randomUUID()}\n`;
  let releasing = false;
  let acquired = false;
  let output = '';
  const closed = new Promise<number | null>(resolveClosed => child.once('close', resolveClosed));
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child.once('error', rejectReady);
    child.once('close', code => rejectReady(new Error(`Instance lock unavailable (${code})`)));
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(challenge)) { acquired = true; resolveReady(); }
    });
  });
  child.once('close', () => { if (acquired && !releasing) onLost(); });
  child.stdin!.write(challenge);
  await ready;
  return { async release() {
    if (releasing) return;
    releasing = true;
    child.stdin!.end();
    // cat exits after stdin EOF, so this waits until lockf has released the OS lock.
    await closed;
  } };
}
