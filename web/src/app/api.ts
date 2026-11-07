const key = 'agent-platform-token';
export function token() { return sessionStorage.getItem(key) ?? ''; }
export function setToken(value: string) { sessionStorage.setItem(key, value.trim()); }

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, { method: options.method ?? 'GET',
    headers: { authorization: `Bearer ${token()}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result as T;
}
export async function imageUrl(path: string): Promise<string> {
  const response = await fetch(path, { headers: { authorization: `Bearer ${token()}` }, cache: 'no-store' });
  if (!response.ok) throw new Error('图片不可用');
  return URL.createObjectURL(await response.blob());
}
