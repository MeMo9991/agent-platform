import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { legacyGroupVerification } from './legacy-verification.js';
import { readConfigDocuments, readOptionalFile, type ConfigPaths } from './documents.js';

export function loadConfiguration(root: string, environment: NodeJS.ProcessEnv = process.env) {
  const explicitLegacy = environment.AGENT_PLATFORM_CONFIG || environment.AGENT_PLATFORM_SCHEDULES;
  const fileEnvironment = explicitLegacy ? {} : parseEnv(readOptionalFile(resolve(root, '.env')) ?? '');
  const env = { ...fileEnvironment, ...environment };
  const yamlPath = resolve(root, 'config/local.yaml');
  const jsonPath = resolve(root, 'config/local.json');
  const yamlBytes = readOptionalFile(yamlPath);
  const jsonBytes = readOptionalFile(jsonPath);
  if (yamlBytes !== undefined && jsonBytes !== undefined)
    throw new Error('config/local.yaml and config/local.json both exist; keep only one active configuration');
  const localPath = jsonBytes === undefined ? yamlPath : jsonPath;
  const localBytes = yamlBytes ?? jsonBytes;
  const legacyPaths = Boolean(env.AGENT_PLATFORM_CONFIG || env.AGENT_PLATFORM_SCHEDULES);
  if (localBytes !== undefined && legacyPaths)
    throw new Error(`${localPath} conflicts with AGENT_PLATFORM_CONFIG or AGENT_PLATFORM_SCHEDULES`);
  const paths: ConfigPaths = legacyPaths ? {
    platform: resolve(root, env.AGENT_PLATFORM_CONFIG || 'config/platform.json'),
    schedules: resolve(root, env.AGENT_PLATFORM_SCHEDULES || 'config/schedules.json'),
  } : { local: localPath };
  const documents = readConfigDocuments(paths, localBytes);
  const local = documents.local;
  const platform = local ? documents.platform : { ...documents.platform,
    projectGroups: documents.platform.projectGroups.map(group => ({ ...group,
      verification: group.verification === true ? legacyGroupVerification(group.projectKey) ?? true : group.verification })),
  };

  function configured<T>(value: T | undefined, key: string, parse: (raw: string) => T, fallback: T): T {
    const raw = env[key];
    if (raw === undefined || raw === '') return value ?? fallback;
    let legacy: T;
    try { legacy = parse(raw); }
    catch { throw new Error(`Invalid ${key}`); }
    if (value !== undefined && value !== legacy) throw new Error(`${localPath} conflicts with ${key}`);
    return value ?? legacy;
  }

  const path = (value: string) => resolve(root, value);
  const flag = (value: string) => z.enum(['0', '1']).parse(value) === '1';
  const nonnegative = (value: string) => z.coerce.number().nonnegative().parse(value);
  const runtimeRoot = configured(local?.instance?.runtimeRoot && path(local.instance.runtimeRoot),
    'AGENT_PLATFORM_RUNTIME_ROOT', path, path('.runtime'));
  const database = configured(local?.instance?.database && path(local.instance.database),
    'AGENT_PLATFORM_DATABASE', path, resolve(runtimeRoot, 'state/agent-platform.sqlite3'));
  const capabilities = {
    stage5Worker: configured(local?.capabilities?.stage5Worker, 'AGENT_PLATFORM_STAGE5_WORKER_ENABLED', flag, false),
    qoderWrite: configured(local?.capabilities?.qoderWrite, 'AGENT_PLATFORM_QODER_WRITE_ENABLED', flag, false),
    stage5Writes: configured(local?.capabilities?.stage5Writes, 'AGENT_PLATFORM_STAGE5_WRITES_ENABLED', flag, false),
  };
  const retentionDays = configured(local?.maintenance?.workspaceRetentionDays,
    'AGENT_PLATFORM_WORKSPACE_RETENTION_DAYS', nonnegative, 7);
  const orphanHours = configured(local?.maintenance?.workspaceOrphanHours,
    'AGENT_PLATFORM_WORKSPACE_ORPHAN_HOURS', nonnegative, 24);
  const authProvider = configured(local?.tools?.devopsAuthProvider && path(local.tools.devopsAuthProvider),
    'AGENT_PLATFORM_AUTH_PROVIDER', path, undefined);
  const javaHome = local?.tools?.javaHome ? path(local.tools.javaHome) : env.JAVA_HOME;
  const mavenSettings = local?.tools?.mavenSettings ? path(local.tools.mavenSettings) : env.MAVEN_SETTINGS;
  for (const [file, key] of [
    [local?.credentials?.devopsFile, 'DEVOPS_CREDENTIALS_PATH'],
    [local?.credentials?.codeHostFile, 'AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH'],
    [local?.credentials?.qoderPatFile, 'AGENT_PLATFORM_QODER_PAT_PATH'],
  ] as const) {
    const credentialFile = configured(file && path(file), key, path, undefined);
    if (credentialFile) env[key] = credentialFile;
  }
  if (javaHome) accessSync(resolve(root, javaHome, 'bin/java'), constants.X_OK);
  if (mavenSettings && !statSync(resolve(root, mavenSettings)).isFile()) throw new Error('Maven settings must be a file');
  if (authProvider && !statSync(authProvider).isFile()) throw new Error('DevOps authorization provider must be a file');
  return { ...documents, platform, paths, env, runtimeRoot, database, capabilities,
    authProvider, javaHome: javaHome && path(javaHome), mavenSettings: mavenSettings && path(mavenSettings),
    workspaceRetentionMs: retentionDays * 86_400_000, workspaceOrphanGraceMs: orphanHours * 3_600_000 };
}
