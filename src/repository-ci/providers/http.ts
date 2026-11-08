import type { z } from 'zod';
import type { repositoryConfig } from '../model.js';

export type Repository = z.infer<typeof repositoryConfig>;
export function credential(repo: Repository): string {
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(repo.credentialsRef);
  const value = match && process.env[match[1]!];
  if (!value) throw new Error(`Code-host credential is unavailable for ${repo.repoKey}`);
  if (!/^[\x21-\x7e]+$/.test(value))
    throw new Error(`Code-host credential has whitespace, control or non-ASCII characters for ${repo.repoKey}`);
  return value;
}
export async function jsonRequest<T>(url: string, token: string, provider: 'github' | 'gitlab',
  method = 'GET', body?: unknown, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(url, { method, headers: {
    accept: 'application/json', ...(provider === 'github'
      ? { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' }
      : { 'private-token': token }),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${provider} API ${method} returned HTTP ${response.status}`);
  return await response.json() as T;
}
export function baseUrl(repo: Repository, provider: 'github' | 'gitlab'): string {
  const host = new URL(repo.hostUrl);
  if (host.protocol !== 'https:' || host.username || host.password || host.search || host.hash || host.pathname !== '/')
    throw new Error('Code-host URL must be an HTTPS origin');
  const base = host.origin.replace(/\/$/, '');
  return provider === 'github' ? (host.hostname === 'github.com' ? 'https://api.github.com' : `${base}/api/v3`)
    : `${base}/api/v4`;
}
export function fullSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Code-host SHA is invalid');
  return value;
}
