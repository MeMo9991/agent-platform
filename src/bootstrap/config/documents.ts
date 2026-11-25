import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { id } from '../../shared/model.js';
import { platformConfig, platformFields, type PlatformConfig } from './config.js';
import { scheduleConfig, type ScheduleConfig } from '../schedules/scheduler.js';

export type LegacyConfigPaths = { platform: string; schedules: string };
export type ConfigPaths = LegacyConfigPaths | { local: string };

const localConfig = z.strictObject({
  platform: z.record(z.string(), z.unknown()).default({}),
  schedules: scheduleConfig.shape.tasks.default([]),
  instance: z.strictObject({ runtimeRoot: id.optional(), database: id.optional() }).optional(),
  capabilities: z.strictObject({
    stage5Worker: z.boolean().optional(), qoderWrite: z.boolean().optional(), stage5Writes: z.boolean().optional(),
  }).optional(),
  tools: z.strictObject({ javaHome: id.optional(), mavenSettings: id.optional(), devopsAuthProvider: id.optional() }).optional(),
  credentials: z.strictObject({ devopsFile: id.optional(), codeHostFile: id.optional(), qoderPatFile: id.optional() }).optional(),
  maintenance: z.strictObject({
    workspaceRetentionDays: z.number().nonnegative().optional(), workspaceOrphanHours: z.number().nonnegative().optional(),
  }).optional(),
});

const defaultInteraction = {
  actorId: 'local-owner', roles: ['answer', 'route', 'approve', 'reopen', 'submit', 'command', 'configure'],
  credentialFile: '~/.config/agent-platform/local-api.token', port: 8765,
};

export function readOptionalFile(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function parseFile<T>(path: string, bytes: string, parse: (raw: unknown) => T): T {
  try {
    if (!path.endsWith('.yaml')) return parse(JSON.parse(bytes));
    const document = parseDocument(bytes, { schema: 'core', stringKeys: true });
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem) throw problem;
    return parse(document.contents === null ? {} : document.toJS({ maxAliasCount: 0 }));
  }
  catch (error) { throw new Error(`Invalid configuration in ${path}: ${(error as Error).message}`); }
}

export function validateConfiguredDocuments(platform: PlatformConfig, schedules: ScheduleConfig): void {
  const scans = new Set<string>();
  const sourceIds = new Set(platform.sources.map(source => source.id));
  const devopsProjects = new Set<number>();
  for (const task of schedules.tasks) {
    if (sourceIds.has(task.id) || task.id.startsWith('manual:'))
      throw new Error(`Duplicate or reserved event source ID ${task.id}`);
    sourceIds.add(task.id);
    const group = platform.projectGroups.find(item => item.projectKey === task.projectKey);
    if (!group) throw new Error(`Scheduled task ${task.id} has no matching project group`);
    const scan = `${task.kind}:${task.projectKey}`;
    if (scans.has(scan)) throw new Error(`Duplicate scheduled scan for project group ${task.projectKey}`);
    scans.add(scan);
    if (task.kind === 'devops-defect-poll') {
      if (devopsProjects.has(task.businessProjectId)) throw new Error('Duplicate DevOps businessProjectId');
      devopsProjects.add(task.businessProjectId);
    } else if (!group.repositories.length || group.repositories.some(repo => repo.provider !== 'github'))
      throw new Error(`GitHub PR scan requires GitHub repositories in ${task.projectKey}`);
  }
  if (platform.agents.some(agent => agent.enabled && agent.kind !== 'qoder'))
    throw new Error('Only Qoder is available in this stage');
}

export function readConfigDocuments(paths: ConfigPaths, localBytes?: string) {
  const revision = (platform: string, schedules: string) =>
    createHash('sha256').update(platform).update('\0').update(schedules).digest('hex');
  if ('local' in paths) {
    const platformBytes = localBytes ?? readOptionalFile(paths.local) ?? '{}';
    const { local, platform, schedules } = parseFile(paths.local, platformBytes, raw => {
      const local = localConfig.parse(raw);
      const rawPlatform = local.platform;
      for (const key of Object.keys(rawPlatform))
        if (!Object.hasOwn(platformFields, key)) throw new Error(`Unknown platform setting ${key}`);
      const budget = z.strictObject(platformFields.budget.shape).partial().optional().parse(rawPlatform.budget);
      const { interaction: rawInteraction, ...settings } = rawPlatform;
      const interaction = z.union([z.literal(false), z.strictObject(platformFields.interaction.unwrap().shape).partial()])
        .optional().parse(rawInteraction);
      const platform = platformConfig.parse({
        agents: [], policyRef: 'default', ...settings,
        budget: { maxRunMs: 600000, ...budget },
        ...(interaction === false ? {} : { interaction: { ...defaultInteraction, ...interaction } }),
      });
      for (const group of platform.projectGroups)
        if (group.verification === true) throw new Error(`Project group ${group.projectKey} must set verification.type`);
      const schedules = scheduleConfig.parse({ tasks: local.schedules });
      validateConfiguredDocuments(platform, schedules);
      return { local, platform, schedules };
    });
    return { platform, platformRaw: local.platform, schedules, local, revision: revision(platformBytes, '') };
  }
  const platformBytes = readFileSync(paths.platform, 'utf8');
  const scheduleBytes = readFileSync(paths.schedules, 'utf8');
  const { platform, platformRaw } = parseFile(paths.platform, platformBytes, raw =>
    ({ platform: platformConfig.parse(raw), platformRaw: raw as Record<string, unknown> }));
  const schedules = parseFile(paths.schedules, scheduleBytes, scheduleConfig.parse);
  validateConfiguredDocuments(platform, schedules);
  return { platform, platformRaw, schedules, local: undefined, revision: revision(platformBytes, scheduleBytes) };
}
