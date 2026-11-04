import { z } from 'zod';
import { id, timestamp } from '../shared/model.js';

export const repositoryConfig = z.object({ repoKey: id, provider: z.enum(['github', 'gitlab']), hostUrl: z.url(),
  projectRef: id, targetBranch: id, requiredChecks: z.array(id), credentialsRef: id });
export const changeRef = z.object({ provider: z.enum(['github', 'gitlab']), repoKey: id, id, sourceSha: id, targetSha: id });
export const checkResult = z.object({ repoKey: id, commitSha: id, status: z.enum(['pending', 'completed']),
  conclusion: z.enum(['success', 'failure', 'unknown']), logRef: id.optional() });
export const changeSnapshot = z.object({ change: changeRef, state: z.enum(['open', 'merged', 'closed', 'unknown']),
  sourceSha: id, targetSha: id, checks: z.array(checkResult), gate: z.enum(['ready', 'blocked', 'unknown']), observedAt: timestamp });
export const releaseRequest = z.object({ operation: z.enum(['deploy', 'rollback']), taskId: id, repoKey: id,
  mergedSha: id, environment: id, releaseVersion: id, artifactRef: id.optional(),
  pipelineConfigRef: id, paramsDigest: id, requestKey: id });
export const releaseSnapshot = z.object({ runRef: id, requestKey: id.optional(), operation: z.enum(['deploy', 'rollback']),
  environment: id, state: z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown']),
  deployedVersion: id.optional(), artifactRef: id.optional(), mergedSha: id.optional(), logRef: id.optional(), observedAt: timestamp });
export const releaseResult = z.object({ runRef: id, requestKey: id });
export interface CodeHost {
  readonly repoKey: string;
  readonly provider: 'github' | 'gitlab';
  readChecks(commitSha: string): Promise<z.infer<typeof checkResult>[]>;
  openChange(request: { sourceSha: string; targetBranch: string }): Promise<z.infer<typeof changeRef>>;
  readChange(change: z.infer<typeof changeRef>): Promise<z.infer<typeof changeSnapshot>>;
  merge(request: { change: z.infer<typeof changeRef>; expectedSourceSha: string }): Promise<{ merged: boolean }>;
}
export interface ReleasePipeline {
  readonly repoKey: string;
  readonly environment: string;
  start(request: z.infer<typeof releaseRequest>): Promise<z.infer<typeof releaseResult>>;
  findByRequestKey(requestKey: string): Promise<z.infer<typeof releaseSnapshot> | undefined>;
  read(runRef: string): Promise<z.infer<typeof releaseSnapshot>>;
}
