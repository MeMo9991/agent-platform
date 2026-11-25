import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformConfig } from '../src/bootstrap/config/config.js';
import { scheduleConfig } from '../src/bootstrap/schedules/scheduler.js';
import { createGithubPrTask, githubPrMetadataFields } from '../src/bootstrap/schedules/github-pr-task.js';
import { createEventIngress } from '../src/event/ingress.js';
import { SqliteStore } from '../src/storage/sqlite/store.js';

test('GitHub PR scan creates one read-only event per external PR revision in its project group', async t => {
  const config = JSON.parse(readFileSync('config/platform.json', 'utf8'));
  config.projectGroups[0].repositories[0].credentialsRef = 'env:TEST_GITHUB_PR_TOKEN';
  const platform = platformConfig.parse(config);
  const task = scheduleConfig.parse(JSON.parse(readFileSync('config/schedules.json', 'utf8'))).tasks[1]!;
  const before = process.env.TEST_GITHUB_PR_TOKEN;
  const previousCredentialsPath = process.env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH;
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-pr-scan-'));
  process.env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH = join(directory, 'credentials.json');
  t.after(() => {
    if (previousCredentialsPath === undefined) delete process.env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH;
    else process.env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH = previousCredentialsPath;
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.TEST_GITHUB_PR_TOKEN = 'test-only';
  const store = new SqliteStore(':memory:', { [task.id]: githubPrMetadataFields });
  store.registerSource(task.id, 'github-pr', task.id, true);
  let headSha = 'a'.repeat(40);
  const urls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    urls.push(String(input));
    assert.ok(new Headers(init?.headers).get('Authorization') === 'Bearer test-only', 'Expected the fixture credential');
    const item = (number: number, ref: string, base = 'main') => ({ number, title: `PR ${number}`, body: '修复说明',
      updated_at: '2026-11-10T10:00:00Z', draft: false, head: { sha: headSha, ref }, base: { ref: base } });
    return Response.json([item(4, 'fix/bug'), item(5, 'agent-platform/task'), item(6, 'fix/other', 'develop')]);
  };
  try {
    const scan = createGithubPrTask(platform, createEventIngress(store, { [task.id]: githubPrMetadataFields }), request);
    await scan(task);
    await scan(task);
    assert.equal(store.listPending(10).length, 1);
    const event = store.listPending(10)[0]!;
    assert.deepEqual([event.sourceId, event.externalId, event.repoKey, event.kind],
      ['agent-platform-prs', 'agent-platform#4', 'agent-platform', 'pull_request']);
    assert.equal(event.metaData.baseBranch, 'main');
    assert.ok(urls.every(url => url.includes('state=open&base=main')));
    headSha = 'b'.repeat(40);
    await scan(task);
    assert.equal(store.listPending(10).length, 2);
  } finally {
    if (before === undefined) delete process.env.TEST_GITHUB_PR_TOKEN;
    else process.env.TEST_GITHUB_PR_TOKEN = before;
    store.close();
  }
});
