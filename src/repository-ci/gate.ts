import type { z } from 'zod';
import type { changeSnapshot } from './model.js';

export function checksReady(snapshot: z.infer<typeof changeSnapshot>, required: readonly string[]): boolean {
  if (snapshot.state !== 'open' || snapshot.gate !== 'ready' ||
      snapshot.change.sourceSha !== snapshot.sourceSha || snapshot.change.targetSha !== snapshot.targetSha ||
      !/^[a-f0-9]{40}$/.test(snapshot.sourceSha) || !/^[a-f0-9]{40}$/.test(snapshot.targetSha)) return false;
  return required.length > 0 && new Set(required).size === required.length && required.every(name => {
    const found = snapshot.checks.filter(check => check.name === name && check.repoKey === snapshot.change.repoKey &&
      check.commitSha === snapshot.sourceSha);
    return found.length === 1 && found[0]!.status === 'completed' && found[0]!.conclusion === 'success';
  });
}
