import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScheduleConfig, scheduleConfig, startSchedules } from '../src/bootstrap/scheduler.js';
import { startConfiguredSchedules } from '../src/bootstrap/start-schedules.js';

test('schedule file binds scans to project groups and rejects duplicate identities', () => {
  const config = loadScheduleConfig('config/schedules.json');
  assert.deepEqual(config.tasks.map(task => [task.id, task.kind, task.intervalSeconds]),
    [['devops-assigned-defects', 'devops-defect-poll', 300]]);
  assert.deepEqual(config.tasks[0]?.parameters, { sourceId: 'devops-assigned' });
  assert.throws(() => scheduleConfig.parse({ tasks: [config.tasks[0], config.tasks[0]] }), /Duplicate scheduled task ID/);
  assert.throws(() => startSchedules(config, {}, () => {}), /No handler/);
});

test('startup rejects duplicate scans, invalid DevOps projects and unknown groups before timers start', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-schedule-'));
  const paths = { platform: join(directory, 'platform.json'), schedules: join(directory, 'schedules.json'), database: ':memory:' };
  const platform = JSON.parse(readFileSync('config/platform.json', 'utf8'));
  const schedule = loadScheduleConfig('config/schedules.json');
  try {
    writeFileSync(paths.platform, JSON.stringify(platform));
    writeFileSync(paths.schedules, JSON.stringify({ tasks: [schedule.tasks[0],
      { ...schedule.tasks[0], id: 'second-scan' }] }));
    assert.throws(() => startConfiguredSchedules(paths, async () => ({}), () => {}), /Duplicate scheduled scan for source/);
    platform.sources[0].devops.businessProjectId = 0;
    writeFileSync(paths.platform, JSON.stringify(platform));
    assert.throws(() => startConfiguredSchedules(paths, async () => ({}), () => {}), /businessProjectId/);
    platform.sources[0].devops.businessProjectId = 4655971863;
    writeFileSync(paths.schedules, JSON.stringify(schedule));
    platform.sources[0].enabled = false;
    writeFileSync(paths.platform, JSON.stringify(platform));
    assert.throws(() => startConfiguredSchedules(paths, async () => ({}), () => {}), /matching enabled DevOps source/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('one scheduler runs independent tasks, skips overlap, reports errors and waits on stop', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const errors: string[] = [];
  const [devops, github] = loadScheduleConfig('config/schedules.json').tasks;
  const config = scheduleConfig.parse({ tasks: [
    { ...devops, id: 'slow', enabled: true, intervalSeconds: 1 },
    { ...github, id: 'failing', enabled: true, intervalSeconds: 1 },
    { ...devops, id: 'off', enabled: false, intervalSeconds: 1 },
  ] });
  const stop = startSchedules(config, {
    'devops-defect-poll': async task => { calls.push(task.id); await gate; },
    'github-pr-poll': async task => { calls.push(task.id); throw new Error('expected failure'); },
  }, (id, error) => { errors.push(`${id}: ${String(error)}`); });
  await delay(1100);
  assert.equal(calls.filter(call => call === 'slow').length, 1);
  assert.equal(calls.includes('off'), false);
  assert.equal(errors.some(error => error.includes('failing: Error: expected failure')), true);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await delay(0);
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(stopped, true);
});
