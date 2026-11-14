import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQoderRunner } from '../src/agent/worker/agents/qoder.js';
import { buildQoderSystemPrompt } from '../src/agent/worker/agents/qoder/system-prompt.js';

test('Qoder reads edited prompt text for each new session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qoder-prompt-'));
  try {
    writeFileSync(join(directory, 'system-prompt.md'), '{{mandate}}\n{{skill}}');
    writeFileSync(join(directory, 'investigate.md'), 'Investigate only');
    const request = { stage: 'investigate', mandate: { goal: 'Investigate' },
      skill: { content: 'Read only' }, workspace: { baseSha: 'a'.repeat(40) } } as Parameters<typeof buildQoderSystemPrompt>[0];
    assert.match(buildQoderSystemPrompt(request, directory), /Investigate only$/);
    writeFileSync(join(directory, 'investigate.md'), 'Investigate the owner first');
    assert.match(buildQoderSystemPrompt(request, directory), /Investigate the owner first$/);
    assert.throws(() => { writeFileSync(join(directory, 'system-prompt.md'), '{{skill}}');
      buildQoderSystemPrompt(request, directory); }, /required placeholder/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('investigate prompt is read-only, avoids repeated searches and owns the question contract', () => {
  const prompt = buildQoderSystemPrompt({ stage: 'investigate', mandate: { goal: 'Investigate' },
    workspace: { baseSha: 'a'.repeat(40) } } as Parameters<typeof buildQoderSystemPrompt>[0]);
  assert.match(prompt, /strictly read-only/);
  assert.match(prompt, /Do not repeat the same tool call/);
  assert.match(prompt, /"kind":"question"/);
  assert.match(prompt, /normal investigation conclusion/);
});

test('develop owns the question contract without a separate question prompt', () => {
  const prompt = buildQoderSystemPrompt({ stage: 'develop', mandate: { goal: 'Edit' },
    workspace: { baseSha: 'a'.repeat(40) } } as Parameters<typeof buildQoderSystemPrompt>[0]);
  assert.match(prompt, /"kind":"question"/);
  assert.match(prompt, /normal development result/);
});

test('review prompt requires reviewer role and one raw JSON object', () => {
  const prompt = buildQoderSystemPrompt({ stage: 'review', mandate: { goal: 'Review' },
    workspace: { baseSha: 'a'.repeat(40) } } as Parameters<typeof buildQoderSystemPrompt>[0]);
  assert.match(prompt, /independent reviewer/);
  assert.match(prompt, /one raw JSON object/);
  assert.match(prompt, /a{40}/);
});

test('develop grants only the built-in tools needed to edit and commit in its sandbox', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qoder-develop-'));
  const workspace = join(directory, 'clone');
  mkdirSync(workspace);
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: () => true }) as unknown as ChildProcess;
  const runner = createQoderRunner({ verified: true, launch(_command, args) {
    assert.equal(args.filter(arg => arg === '--append-system-prompt').length, 1);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypass_permissions');
    assert.match(args[args.indexOf('--append-system-prompt') + 1]!, /Commit authorized changes.*Git worktree clean/);
    assert.match(args[args.indexOf('--append-system-prompt') + 1]!, /previousResults are historical, unverified reports/);
    assert.match(args[args.indexOf('--append-system-prompt') + 1]!, /"kind":"question"/);
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
    assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 9),
      ['--tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash',
        '--allowed-tools', 'Read,Grep,Glob,Edit,Write,Bash']);
    return { process: child, terminate: () => true, isTerminated: () => true };
  } }, directory);
  try {
    const started = runner.start({ taskId: 'task', runId: 'run', stage: 'develop', repoKey: 'repo',
      mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Edit', allowedActions: ['edit'],
        maxAutoRisk: 'high', policyVersion: 'p1', authority: { kind: 'human_approval', approvalRef: 'approval' } },
      workspace: { repoKey: 'repo', path: workspace, baseSha: 'a'.repeat(40) },
      input: { kind: 'task', runId: 'run', prompt: 'Edit', sourceEventIds: [] },
      skill: { content: 'Edit', ref: { repoRef: 'repo', path: 'skills/develop/SKILL.md',
        commitSha: 'a'.repeat(40), stage: 'develop' } },
      execution: { verified: true, runId: 'run', repoKey: 'repo', workspacePath: workspace,
        mode: 'write', adapterVersion: 'test', configDigest: 'digest' }, timeoutMs: 1000 });
    child.stdout?.emit('data', JSON.stringify({ type: 'result', subtype: 'success',
      session_id: 'develop-session', result: 'Done', is_error: false }) + '\n');
    child.emit('close', 0);
    await started;
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('review asks for one raw JSON verdict bound to the pinned SHA', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qoder-review-'));
  const workspace = join(directory, 'clone');
  mkdirSync(workspace);
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: () => true }) as unknown as ChildProcess;
  const sha = 'b'.repeat(40);
  const runner = createQoderRunner({ verified: true, launch(_command, args) {
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dont_ask');
    assert.match(args[args.indexOf('--append-system-prompt') + 1]!, /one raw JSON object/);
    assert.match(args[args.indexOf('--append-system-prompt') + 1]!, new RegExp(`"subjectSha":"exactly ${sha}"`));
    assert.match(args[args.indexOf('--append-system-prompt') + 1]!, /Do not use Markdown, code fences, prose/);
    return { process: child, terminate: () => true, isTerminated: () => true };
  } }, directory);
  try {
    const started = runner.start({ taskId: 'task', runId: 'review-run', stage: 'review', repoKey: 'repo',
      mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Review', allowedActions: ['investigate'],
        maxAutoRisk: 'low', policyVersion: 'p1', authority: { kind: 'trusted_rule', ruleRef: 'rule' } },
      workspace: { repoKey: 'repo', path: workspace, baseSha: sha },
      input: { kind: 'task', runId: 'review-run', prompt: 'Review', sourceEventIds: [] },
      skill: { content: 'Review', ref: { repoRef: 'repo', path: 'skills/review/SKILL.md',
        commitSha: sha, stage: 'review' } },
      execution: { verified: true, runId: 'review-run', repoKey: 'repo', workspacePath: workspace,
        mode: 'read', adapterVersion: 'test', configDigest: 'digest' }, timeoutMs: 1000 });
    child.stdout?.emit('data', JSON.stringify({ type: 'result', subtype: 'success',
      session_id: 'review-session', result: `{"subjectSha":"${sha}","verdict":"pass","findings":[]}`, is_error: false }) + '\n');
    child.emit('close', 0);
    await started;
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Qoder confirms input only after assistant output and keeps an early exit pending', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qoder-runner-'));
  const workspace = join(directory, 'clone');
  const inputDirectory = join(workspace, '.git', 'agent-input');
  mkdirSync(inputDirectory, { recursive: true });
  const imagePath = join(inputDirectory, 'sample.png');
  writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: () => true }) as unknown as ChildProcess;
  let launched = false;
  const runner = createQoderRunner({ verified: true, launch(command, args, cwd, proof) {
    launched = true;
    assert.equal(command, 'qoderclicn');
    assert.equal(cwd, workspace);
    assert.equal(proof.runId, 'run-1');
    assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    // 临时关闭自定义 Skill：即使请求里带了 skill 内容，也不再注入系统提示词。
    assert.doesNotMatch(args[args.indexOf('--append-system-prompt') + 1]!, /Pinned skill content/);
    assert.doesNotMatch(args[args.indexOf('--append-system-prompt') + 1]!, /Bug/);
    assert.match(args.at(-1)!, /Bug/);
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dont_ask');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 6),
      ['--tools', 'Read', 'Grep', 'Glob', '--allowed-tools', 'Read,Grep,Glob']);
    assert.equal(args[args.indexOf('--attachment') + 1], realpathSync(imagePath));
    return { process: child, terminate: () => true, isTerminated: () => true };
  } }, directory);
  assert.equal(runner.capabilities().cancel, 'supported');
  assert.equal(runner.capabilities().resume, 'unsupported');
  assert.equal(runner.capabilities().send, 'unsupported');
  assert.equal(runner.capabilities().attachments, 'supported');
  assert.equal(runner.capabilities().usage, 'unverified');
  try {
    const request = { taskId: 'task-1', runId: 'run-1', stage: 'investigate' as const,
      mandate: { sourceEventId: 'event-1', repoKey: 'agent-platform', goal: 'Investigate',
        allowedActions: ['investigate'] as Array<'investigate'>, maxAutoRisk: 'low' as const,
        policyVersion: 'p1', authority: { kind: 'trusted_rule' as const, ruleRef: 'rule' } },
      repoKey: 'agent-platform', workspace: { repoKey: 'agent-platform', path: workspace, baseSha: 'a'.repeat(40) },
      input: { kind: 'task' as const, runId: 'run-1', prompt: 'Bug', sourceEventIds: ['event-1'] },
      skill: { content: 'Pinned skill content', ref: { repoRef: 'agent-platform',
        path: 'skills/investigate/SKILL.md', commitSha: 'a'.repeat(40), stage: 'investigate' as const } },
      execution: { verified: true as const, runId: 'run-1', repoKey: 'agent-platform',
        workspacePath: workspace, mode: 'read' as const, adapterVersion: 'test', configDigest: 'digest' },
      attachmentPaths: [imagePath],
      timeoutMs: 1000 };
    const outsidePath = join(directory, 'outside.png');
    writeFileSync(outsidePath, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    await assert.rejects(runner.start({ ...request, attachmentPaths: [outsidePath] }), /outside the Run input directory/);
    let completed = false;
    const starting = runner.start(request).then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(launched, true);
    assert.equal(completed, false);
    child.stdout?.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-1' }) + '\n');
    await Promise.resolve();
    assert.equal(completed, false);
    child.stdout?.emit('data', JSON.stringify({ type: 'assistant', session_id: 'native-1',
      message: { content: [{ type: 'text', text: 'Investigating' }] } }) + '\n');
    await starting;
    let cancellationConfirmed = false;
    const cancelling = runner.cancel('native-1').then(value => { cancellationConfirmed = true; return value; });
    await Promise.resolve();
    assert.equal(cancellationConfirmed, false);
    child.stdout?.emit('data', JSON.stringify({ type: 'result', subtype: 'success',
      session_id: 'native-1', result: 'Investigated', is_error: false }) + '\n');
    child.emit('close', 0);
    const finished = await runner.read('native-1');
    assert.equal(finished.kind, 'finished');
    assert.equal(finished.kind === 'finished' && finished.exitCode, 0);
    const resultRef = finished.kind === 'finished' ? finished.resultRef! : '';
    const restarted = createQoderRunner({ verified: true, launch() { throw new Error('unexpected launch'); } }, directory);
    assert.equal((await restarted.read('native-1')).kind, 'unknown');
    assert.equal((await restarted.readDurable!('run-1', 'native-1')).kind, 'finished');
    assert.equal(await restarted.resultSummary!('run-1', 'native-1', resultRef), 'Investigated');
    assert.equal((await restarted.readDurable!('run-1', 'wrong-session')).kind, 'unknown');
    const savedLog = JSON.parse(readFileSync(resultRef, 'utf8'));
    writeFileSync(resultRef, JSON.stringify({ ...savedLog, terminationConfirmed: false }));
    assert.equal((await restarted.readDurable!('run-1', 'native-1')).kind, 'unknown');
    await assert.rejects(restarted.resultSummary!('run-1', 'native-1', resultRef), /unavailable or mismatched/);
    assert.deepEqual(await cancelling, { kind: 'accepted' });
    const early = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) as ChildProcess;
    const earlyRunner = createQoderRunner({ verified: true,
      launch() { return { process: early, terminate: () => true, isTerminated: () => true }; } }, directory);
    const startingEarly = assert.rejects(earlyRunner.start(request), error =>
      error instanceof Error && /exited before confirming/.test(error.message) &&
      (error as Error & { terminationConfirmed?: boolean }).terminationConfirmed === true);
    early.stdout?.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-2' }) + '\n');
    early.emit('close', 1);
    await startingEarly;
    let terminated = false;
    const stalled = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) as ChildProcess;
    const stalledRunner = createQoderRunner({ verified: true,
      launch() { return { process: stalled, terminate: () => {
        terminated = true; stalled.emit('close', 143); return true;
      }, isTerminated: () => true }; } }, directory);
    const startingStalled = assert.rejects(stalledRunner.start({ ...request, timeoutMs: 10 }),
      /confirmation timed out/);
    stalled.stdout?.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-3' }) + '\n');
    await startingStalled;
    assert.equal(terminated, true);
    const resultOnly = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) as ChildProcess;
    const resultRunner = createQoderRunner({ verified: true,
      launch() { return { process: resultOnly, terminate: () => true, isTerminated: () => true }; } }, directory);
    const resultRequest = { ...request, input: { ...request.input, runId: 'run-1' } };
    const startingResult = resultRunner.start(resultRequest);
    resultOnly.stdout?.emit('data', JSON.stringify({ type: 'result', subtype: 'success',
      session_id: 'native-4', result: 'Done', is_error: false }) + '\n');
    resultOnly.emit('close', 0);
    assert.equal((await startingResult).sessionId, 'native-4');
    assert.equal((await restarted.readDurable!('run-1', 'native-4')).kind, 'finished');
    const orphan = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) as ChildProcess;
    const orphanRunner = createQoderRunner({ verified: true,
      launch() { return { process: orphan, terminate: () => true, isTerminated: () => false }; } }, directory);
    const orphanRequest = { ...request, runId: 'run-orphan',
      input: { ...request.input, runId: 'run-orphan' }, execution: { ...request.execution, runId: 'run-orphan' } };
    const startingOrphan = orphanRunner.start(orphanRequest);
    orphan.stdout?.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-orphan' }) + '\n');
    orphan.stdout?.emit('data', JSON.stringify({ type: 'assistant', session_id: 'native-orphan',
      message: { content: [{ type: 'text', text: 'Starting' }] } }) + '\n');
    await startingOrphan;
    orphan.emit('close', 0);
    assert.equal((await orphanRunner.read('native-orphan')).kind, 'unknown');
    assert.deepEqual(await orphanRunner.cancel('native-orphan'), { kind: 'unsupported' });
    assert.equal((await orphanRunner.readDurable!('run-orphan', 'native-orphan')).kind, 'unknown');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
