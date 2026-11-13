import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { id, timestamp } from '../shared/model.js';

export const checkCommand = z.object({ command: id, args: z.array(z.string()), timeoutMs: z.number().int().positive() });
export type CheckCommand = z.infer<typeof checkCommand>;
const checkEnvironmentKey = /(?:token|secret|password|credential|key|qodercn|agent_platform)/i;
export const verifyConfig = z.object({
  mode: z.enum(['agent', 'platform']).default('agent'),
  workspace: z.enum(['clone', 'copy']).default('copy'),
  prepare: z.array(checkCommand).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cacheKeyFiles: z.array(id.refine(file => !isAbsolute(file) && !file.split('/').includes('..'),
    'Cache key file must be a relative path inside the workspace')).default([]),
}).superRefine((value, context) => {
  if (value.mode === 'platform' && value.workspace === 'clone')
    context.addIssue({ code: 'custom', message: 'Platform verification requires a writable workspace copy' });
  for (const [key, item] of Object.entries(value.env)) {
    if (!key || checkEnvironmentKey.test(key) || key.includes('=') || key.includes('\0') ||
        item.includes('\0'))
      context.addIssue({ code: 'custom', message: `Check environment variable ${key || '(empty)'} is not allowed` });
  }
});
export type VerifyConfig = z.infer<typeof verifyConfig>;
export const repositoryConfig = z.object({ repoKey: id, provider: z.enum(['github', 'gitlab']), hostUrl: z.url(),
  projectRef: id, targetBranch: id, requiredChecks: z.array(id), credentialsRef: id, localPath: id.optional(),
  autoPr: z.object({ enabled: z.boolean(), allowedPrefixes: z.array(z.enum(['src/', 'tests/', 'web/src/'])) }).optional(),
  localChecks: z.array(checkCommand).default([]), verify: verifyConfig.optional() });
export const changeRef = z.object({ provider: z.enum(['github', 'gitlab']), repoKey: id, id, sourceSha: id, targetSha: id });
export const checkResult = z.object({ repoKey: id, commitSha: id, status: z.enum(['pending', 'completed']),
  conclusion: z.enum(['success', 'failure', 'unknown']), name: id.optional(), logRef: id.optional() });
export const changeSnapshot = z.object({ change: changeRef, state: z.enum(['open', 'merged', 'closed', 'unknown']),
  sourceSha: id, targetSha: id, mergedSha: id.optional(), preMergeTargetSha: id.optional(),
  checks: z.array(checkResult), gate: z.enum(['ready', 'blocked', 'unknown']), observedAt: timestamp });
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
  readTarget?(branch: string): Promise<string>;
  readBranch?(branch: string): Promise<string | undefined>;
  readRequiredChecks?(branch: string): Promise<string[]>;
  findChangeByBranch?(branch: string): Promise<z.infer<typeof changeRef> | undefined>;
  openChange(request: { sourceSha: string; sourceBranch?: string; targetBranch: string;
    targetSha?: string; title?: string }): Promise<z.infer<typeof changeRef>>;
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
