import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { normalizedEvent, sourceEvent, validateMetadataFields, type EventRepository, type MetadataFields, type NormalizedEvent, type SourceEvent } from '../../event/model.js';
import { task, taskRecord, type Task, type TaskRecord } from '../../agent/task/model.js';
import { subscription, type Subscription } from '../../agent/task/model.js';
import { routeDecision } from '../../agent/router/model.js';
import { transitionTask } from '../../agent/task/transition.js';
import { isBlockingReview } from '../../agent/task/workflow.js';
import type { TaskTransitionResult } from '../../agent/task/transition.js';
import type { z } from 'zod';
import type { actorRef } from '../../shared/model.js';
import type { TaskState } from '../../agent/task/model.js';
import { run, type Run } from '../../agent/worker/model.js';
import { schemaVersion, initialSchema } from './migrations/001.js';
import { migration2 } from './migrations/002.js';
import { migration3 } from './migrations/003.js';
import { migration4 } from './migrations/004.js';
import { migration5 } from './migrations/005.js';
import { approvalRequest, approvalDecision, answer } from '../../interaction/model.js';
import type { routeReviewDecision } from '../../interaction/model.js';
import type { RoutePlan } from '../../agent/kernel/task-loop.js';
import type { CandidateRow } from '../../agent/router/candidate-finder.js';
import { hasCodeChangeIntent } from '../../authorization/auto-pr.js';

export class SqliteStore implements EventRepository {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(path: string, private readonly allowedMetaDataFields: MetadataFields = {}) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA foreign_keys=ON');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (version > schemaVersion) throw new Error(`Unsupported future database version ${version}`);
      if (version < schemaVersion) this.transaction(() => {
        if (version < 1) this.db.exec(initialSchema);
        if (version < 2) this.db.exec(migration2);
        if (version < 3) this.db.exec(migration3);
        if (version < 4) this.db.exec(migration4);
        if (version < 5) this.db.exec(migration5);
        this.db.exec(`PRAGMA user_version=${schemaVersion}`);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction<T>(action: () => T): T {
    const outer = this.transactionDepth === 0;
    const savepoint = `nested_${this.transactionDepth}`;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth++;
    try {
      const value = action();
      this.db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      if (outer) this.db.exec('ROLLBACK');
      else this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally { this.transactionDepth--; }
  }
  accept(input: NormalizedEvent): { eventId: string; duplicate: boolean } {
    const value = normalizedEvent.parse(input);
    validateMetadataFields(value, this.allowedMetaDataFields);
    return this.transaction(() => {
      const source = this.db.prepare('SELECT enabled FROM event_source WHERE id=?').get(value.sourceId);
      if (source?.enabled !== 1) throw new Error(`Source ${value.sourceId} is not registered or enabled`);
      const existing = this.db.prepare('SELECT id FROM source_event WHERE source_id=? AND external_id=? AND revision=?')
        .get(value.sourceId, value.externalId, value.revision);
      if (existing) return { eventId: String(existing.id), duplicate: true };
      const eventId = randomUUID();
      this.db.prepare(`INSERT INTO source_event
        (id,source_id,external_id,revision,kind,title,body,thread_key,object_key,repo_key,url,occurred_at,attachments_json,meta_data,status,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, value.sourceId, value.externalId, value.revision,
        value.kind, value.title, value.body, value.threadKey ?? null, value.objectKey ?? null, value.repoKey ?? null,
        value.url ?? null, value.occurredAt ?? null, JSON.stringify(value.attachments), JSON.stringify(value.metaData),
        'pending', new Date().toISOString());
      return { eventId, duplicate: false };
    });
  }
  get(id: string): SourceEvent | undefined {
    const row = this.db.prepare('SELECT * FROM source_event WHERE id=?').get(id);
    if (!row) return undefined;
    return sourceEvent.parse({ id: row.id, sourceId: row.source_id, externalId: row.external_id, revision: row.revision,
      kind: row.kind, title: row.title, body: row.body, threadKey: row.thread_key ?? undefined,
      objectKey: row.object_key ?? undefined, repoKey: row.repo_key ?? undefined, url: row.url ?? undefined,
      occurredAt: row.occurred_at ?? undefined, attachments: JSON.parse(String(row.attachments_json)),
      metaData: JSON.parse(String(row.meta_data)), status: row.status, receivedAt: row.received_at,
      leaseUntil: row.lease_until ?? undefined, routingData: row.routing_data ? JSON.parse(String(row.routing_data)) : undefined });
  }
  listPending(limit: number): SourceEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Pending event limit must be 1..100');
    return this.db.prepare("SELECT id FROM source_event WHERE status='pending' ORDER BY received_at,id LIMIT ?")
      .all(limit).map(row => this.get(String(row.id))!);
  }
  claimEvent(at: string, leaseUntil: string): SourceEvent | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM source_event WHERE status='pending'
        OR (status='routing' AND lease_until<?) ORDER BY received_at,id LIMIT 1`).get(at);
      if (!row) return undefined;
      this.db.prepare("UPDATE source_event SET status='routing',lease_until=? WHERE id=?")
        .run(leaseUntil, row.id);
      return this.get(String(row.id));
    });
  }
  subscriptionMatches(event: SourceEvent): Array<{ subscription: Subscription; task: Task }> {
    const keys: Array<[string, 'object' | 'thread']> = [];
    if (event.objectKey) keys.push([event.objectKey, 'object']);
    if (event.threadKey) keys.push([event.threadKey, 'thread']);
    return keys.flatMap(([key, kind]) => this.db.prepare(`SELECT s.*,t.payload_json FROM subscription s
      JOIN task t ON t.id=s.task_id WHERE s.source_id=? AND s.target_kind=? AND s.target_key=?`)
      .all(event.sourceId, kind, key).map(row => ({
        subscription: subscription.parse({ taskId: row.task_id, sourceId: row.source_id,
          targetKind: row.target_kind, targetKey: row.target_key, mode: row.mode }),
        task: task.parse(JSON.parse(String(row.payload_json))),
      })));
  }
  candidateRows(repoKey: string, excludedTaskId: string, limit: number): CandidateRow[] {
    return this.db.prepare(`SELECT t.id,substr(t.title,1,2049) AS title,substr(t.scope,1,2049) AS scope,
      t.origin_event_id,substr(e.title,1,2049) AS event_title,substr(e.body,1,2049) AS event_body,
      length(t.title) AS title_length,length(t.scope) AS scope_length,
      length(e.title) AS event_title_length,length(e.body) AS event_body_length FROM task t
      LEFT JOIN source_event e ON e.id=t.origin_event_id
      WHERE t.repo_key=? AND t.id<>? ORDER BY t.updated_at DESC,t.id LIMIT ?`)
      .all(repoKey, excludedTaskId, limit) as CandidateRow[];
  }
  hasBusyRun(taskId: string, iteration: number): boolean {
    return this.db.prepare("SELECT 1 FROM run WHERE task_id=? AND iteration=? AND status IN ('queued','running','waiting_human') LIMIT 1")
      .get(taskId, iteration) !== undefined;
  }
  hasActiveRun(taskId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM run WHERE task_id=? AND
      (status IN ('queued','running','waiting_human') OR
       (status='paused' AND json_extract(payload_json,'$.processTerminationUnconfirmed')=1)) LIMIT 1`)
      .get(taskId) !== undefined;
  }
  commitRoute(eventId: string, plan: RoutePlan, at: string): string | undefined {
    const decision = routeDecision.parse(plan.decision);
    return this.transaction(() => {
      const event = this.get(eventId);
      if (!event || event.status !== 'routing') throw new Error(`Event ${eventId} is not claimed for routing`);
      if (decision.kind === 'needs_human') {
        this.db.prepare("UPDATE source_event SET status='needs_human',lease_until=NULL,routing_data=? WHERE id=?")
          .run(JSON.stringify(decision), eventId);
        return undefined;
      }
      if (decision.kind === 'ignored') {
        this.db.prepare("UPDATE source_event SET status='done',lease_until=NULL,routing_data=? WHERE id=?")
          .run(JSON.stringify(decision), eventId);
        return undefined;
      }
      let taskId: string;
      if (decision.kind === 'new_task') {
        if (decision.mandate.sourceEventId !== eventId || decision.mandate.repoKey !== decision.repoKey ||
            (decision.mandate.authority.kind !== 'trusted_rule' &&
              decision.mandate.authority.kind !== 'auto_pr')) throw new Error('Invalid intake Mandate');
        if (!plan.task || !plan.run || plan.task.id !== plan.run.taskId || plan.taskId !== plan.task.id ||
            plan.task.repoKey !== decision.repoKey || plan.task.mandate.sourceEventId !== eventId ||
            plan.task.parentTaskId !== decision.parentTaskId ||
            JSON.stringify(plan.task.mandate) !== JSON.stringify(decision.mandate) ||
            plan.task.state !== 'new' || plan.task.iteration !== 1 || plan.task.title !== event.title ||
            plan.transitions?.map(item => item.state).join(',') !== 'triaged,queued' ||
            plan.run.stage !== 'investigate' || plan.run.requestKey !== `${plan.task.id}:1:investigate:${eventId}`)
          throw new Error('Invalid new Task route plan');
        if (decision.parentTaskId) {
          const related = this.getTask(decision.parentTaskId);
          if (!related || related.repoKey !== decision.repoKey) throw new Error('Related Task repository mismatch');
        }
        taskId = plan.task.id;
        const existingOrigin = this.db.prepare('SELECT id FROM task WHERE origin_event_id=?').get(eventId);
        const initial: Task = { ...plan.task, originEventId: existingOrigin ? undefined : eventId };
        this.saveTask(initial);
        for (const item of plan.transitions!) this.saveTransition(taskId, item.state, item.reason,
          at, randomUUID(),
          { kind: 'system', id: 'router' });
        for (const item of plan.subscriptions ?? []) {
          if (item.taskId !== taskId || item.sourceId !== event.sourceId || item.mode !== 'handle' ||
              (item.targetKind === 'object' ? item.targetKey !== event.objectKey : item.targetKey !== event.threadKey))
            throw new Error('Invalid route subscription');
          this.saveSubscription(item);
        }
        this.saveRun(plan.run);
      } else {
        const owner = this.getTask(decision.taskId);
        if (!owner) throw new Error('Route owner task was not found');
        if (!owner.mandate.allowedActions.includes('investigate'))
          throw new Error('Route owner task does not allow investigation');
        if (event.repoKey && owner.repoKey !== event.repoKey)
          throw new Error('Route owner task belongs to another repository');
        if (['released', 'closed', 'cancelled'].includes(owner.state))
          throw new Error('Route owner task is closed or cancelled');
        if (plan.taskId !== owner.id || plan.task) throw new Error('Route plan owner changed');
        taskId = owner.id;
      }
      this.saveRecord({ id: randomUUID(), taskId, eventId, kind: 'event_link', mode: 'handle', status: 'pending', at });
      if (decision.kind === 'existing_task') {
        const owner = this.getTask(taskId)!;
        if (plan.run) {
          if (this.hasBusyRun(owner.id, owner.iteration) || plan.run.taskId !== owner.id ||
              plan.run.iteration !== owner.iteration || plan.run.status !== 'queued' ||
              (plan.run.stage !== 'investigate' && plan.run.stage !== 'develop') ||
              (plan.run.stage === 'develop' && !owner.mandate.allowedActions.includes('edit')) ||
              plan.run.requestKey !== `${owner.id}:${owner.iteration}:${plan.run.stage}:${eventId}`)
            throw new Error('Route wake plan is stale');
          this.saveRun(plan.run);
        }
      }
      for (const contextId of decision.contextTaskIds) {
        if (contextId === taskId) continue;
        const context = this.getTask(contextId);
        if (!context || context.repoKey !== (decision.kind === 'new_task' ? decision.repoKey : this.getTask(taskId)!.repoKey))
          throw new Error('Invalid context task');
        this.saveRecord({ id: randomUUID(), taskId: contextId, eventId, kind: 'event_link', mode: 'context', status: 'recorded', at });
      }
      this.db.prepare("UPDATE source_event SET status='done',lease_until=NULL,routing_data=? WHERE id=?")
        .run(JSON.stringify(decision), eventId);
      return taskId;
    });
  }
  saveSubscription(input: Subscription): void {
    const value = subscription.parse(input);
    this.db.prepare(`INSERT OR IGNORE INTO subscription(task_id,source_id,target_kind,target_key,mode)
      VALUES (?,?,?,?,?)`).run(value.taskId, value.sourceId, value.targetKind, value.targetKey, value.mode);
  }
  claimHumanRoute(eventId: string): void {
    const changed = this.db.prepare("UPDATE source_event SET status='routing',lease_until=? WHERE id=? AND status='needs_human'")
      .run(new Date(Date.now() + 60_000).toISOString(), eventId);
    if (changed.changes !== 1) throw new Error('Route review is no longer open');
  }
  auditHumanRoute(eventId: string, decision: ReturnType<typeof routeDecision.parse>,
    value: z.infer<typeof routeReviewDecision>, taskId: string | undefined): void {
    this.db.prepare('UPDATE source_event SET routing_data=? WHERE id=?')
      .run(JSON.stringify({ decision, humanDecision: value, taskId }), eventId);
  }
  registerSource(id: string, kind: string, configRef: string, enabled: boolean): void {
    if (![id, kind, configRef].every(value => typeof value === 'string' && value.trim())) throw new Error('Invalid source registration');
    this.db.prepare(`INSERT INTO event_source(id,kind,config_ref,enabled) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,config_ref=excluded.config_ref,enabled=excluded.enabled`)
      .run(id, kind, configRef, enabled ? 1 : 0);
  }
  saveTask(input: Task): void {
    const value = task.parse(input);
    if (value.mandate.authority.kind === 'auto_pr') {
      const event = this.get(value.mandate.sourceEventId);
      if (!event || event.status !== 'routing' || value.originEventId !== event.id ||
          event.sourceId !== `manual:${value.repoKey}` || event.repoKey !== value.repoKey ||
          event.kind !== 'manual_task' || event.attachments.length ||
          !hasCodeChangeIntent(event.body) || value.mandate.goal !== event.title)
        throw new Error('Automatic development intake lacks trusted code-change intent');
    } else if (value.mandate.authority.kind !== 'trusted_rule')
      throw new Error('Human-approved Mandate requires a verified authorization service');
    this.db.prepare(`INSERT INTO task
      (id,origin_event_id,repo_key,title,scope,mandate,state,iteration,priority,owner,base_ref,parent_task_id,created_at,updated_at,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(value.id, value.originEventId ?? null, value.repoKey, value.title,
      value.scope, JSON.stringify(value.mandate), value.state, value.iteration, value.priority, value.owner ?? null,
      value.baseRef ?? null, value.parentTaskId ?? null, value.createdAt, value.updatedAt, JSON.stringify(value));
  }
  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT payload_json FROM task WHERE id=?').get(id);
    return row ? task.parse(JSON.parse(String(row.payload_json))) : undefined;
  }
  deleteTask(id: string): boolean {
    const task = this.getTask(id);
    if (!task) return false;
    this.transaction(() => {
      this.db.prepare("DELETE FROM task_record WHERE task_id=?").run(id);
      this.db.prepare("DELETE FROM run WHERE task_id=?").run(id);
      this.db.prepare("DELETE FROM task WHERE id=?").run(id);
    });
    return true;
  }
  getReopenByKey(key: string): Extract<TaskRecord, { kind: 'reopen' }> | undefined {
    const row = this.db.prepare("SELECT id FROM task_record WHERE kind='reopen' AND idempotency_key=?").get(key);
    const record = row ? this.getRecord(String(row.id)) : undefined;
    return record?.kind === 'reopen' ? record : undefined;
  }
  saveReopenedTask(previous: Task, next: Task, reopeningRecordId: string): void {
    const value = task.parse(next);
    const record = this.getRecord(reopeningRecordId);
    if (record?.kind !== 'reopen' || record.taskId !== previous.id ||
        record.previousIteration !== previous.iteration || record.nextIteration !== value.iteration ||
        record.previousUpdatedAt !== previous.updatedAt || record.previousState !== previous.state ||
        record.previousBaseSha !== previous.baseRef ||
        value.id !== previous.id || value.repoKey !== previous.repoKey ||
        value.originEventId !== previous.originEventId || value.parentTaskId !== previous.parentTaskId ||
        !['released', 'closed'].includes(previous.state) || value.state !== 'queued' ||
        value.iteration !== previous.iteration + 1 || value.baseRef !== undefined ||
        value.mandate.sourceEventId !== previous.mandate.sourceEventId ||
        value.mandate.policyVersion !== previous.mandate.policyVersion ||
        value.mandate.goal !== previous.mandate.goal || value.mandate.maxAutoRisk !== 'low' ||
        value.mandate.allowedActions.join(',') !== 'investigate' ||
        value.mandate.authority.kind !== 'human_approval' ||
        value.mandate.authority.approvalRef !== reopeningRecordId)
      throw new Error('Invalid Task reopen plan');
    const changed = this.db.prepare(`UPDATE task SET state=?,iteration=?,mandate=?,base_ref=NULL,updated_at=?,payload_json=?
      WHERE id=? AND state=? AND iteration=? AND updated_at=?`)
      .run(value.state, value.iteration, JSON.stringify(value.mandate), value.updatedAt, JSON.stringify(value),
        previous.id, previous.state, previous.iteration, previous.updatedAt);
    if (changed.changes !== 1) throw new Error('Task changed before reopening');
  }
  transferInvestigation(relatedTaskId: string, targetTaskId: string, at: string): void {
    const related = this.getTask(relatedTaskId);
    const target = this.getTask(targetTaskId);
    if (!related || !target || related.parentTaskId !== target.id || related.repoKey !== target.repoKey ||
        related.state !== 'cancelled' || target.state !== 'queued')
      throw new Error('Investigation transfer does not match reopened Task');
    if (this.db.prepare("SELECT 1 FROM task_record WHERE task_id=? AND kind='event_link' AND status IN ('pending','uncertain') LIMIT 1")
      .get(relatedTaskId)) throw new Error('Investigation has unresolved event delivery');
    for (const row of this.db.prepare("SELECT event_id FROM task_record WHERE task_id=? AND kind='event_link' AND status IN ('delivered','handled') AND json_extract(payload_json,'$.mode')='handle'")
      .all(relatedTaskId)) {
      const eventId = String(row.event_id);
      if (!this.db.prepare("SELECT 1 FROM task_record WHERE task_id=? AND event_id=? AND kind='event_link'")
        .get(targetTaskId, eventId))
        this.saveRecord({ id: randomUUID(), taskId: targetTaskId, eventId,
          kind: 'event_link', mode: 'handle', status: 'pending', at });
    }
    for (const row of this.db.prepare("SELECT source_id,target_kind,target_key FROM subscription WHERE task_id=? AND mode='handle'")
      .all(relatedTaskId)) {
      this.db.prepare(`INSERT INTO subscription(task_id,source_id,target_kind,target_key,mode) VALUES (?,?,?,?, 'handle')
        ON CONFLICT(task_id,source_id,target_kind,target_key) DO UPDATE SET mode='handle'`)
        .run(targetTaskId, row.source_id, row.target_kind, row.target_key);
    }
    this.db.prepare("UPDATE subscription SET mode='context' WHERE task_id=? AND mode='handle'").run(relatedTaskId);
  }
  setTaskBaseRef(taskId: string, sha: string): void {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full Git commit SHA');
    this.transaction(() => {
      const current = this.getTask(taskId);
      if (!current || (current.baseRef && current.baseRef !== sha)) throw new Error('Task base SHA changed');
      if (current.baseRef) return;
      const next = task.parse({ ...current, baseRef: sha });
      this.db.prepare('UPDATE task SET base_ref=?,payload_json=? WHERE id=? AND base_ref IS NULL')
        .run(sha, JSON.stringify(next), taskId);
    });
  }
  saveApprovalRequest(input: z.infer<typeof approvalRequest>): void {
    const request = approvalRequest.parse(input);
    this.transaction(() => {
      const current = this.getTask(request.taskId);
      const stageFive = request.kind === 'action' || (request.kind === 'scope_change' &&
        request.proposedMandate.allowedActions.some(action => action === 'open_pr' || action === 'merge'));
      const reviewedSha = stageFive ? this.latestReviewedSha(request.taskId) : undefined;
      const continueRun = request.kind === 'continue'
        ? this.db.prepare("SELECT 1 FROM run WHERE task_id=? AND stage='develop' AND commit_sha=? LIMIT 1")
          .get(request.taskId, request.sourceSha) : undefined;
      if (!current || current.state !== 'waiting_human' ||
          (request.kind !== 'action' && current.iteration !== request.iteration) ||
          (request.kind === 'continue' ? !continueRun
            : stageFive ? reviewedSha !== request.sourceSha : current.baseRef !== request.sourceSha) ||
          current.mandate.policyVersion !== request.policyVersion)
        throw new Error('Approval request does not match current Task, policy and SHA');
      if (request.kind === 'scope_change' && (request.proposedMandate.repoKey !== current.repoKey ||
          request.proposedMandate.sourceEventId !== current.mandate.sourceEventId ||
          request.proposedMandate.policyVersion !== current.mandate.policyVersion ||
          request.proposedMandate.goal !== current.mandate.goal ||
          request.proposedMandate.allowedActions.some(action => !['investigate', 'edit', 'open_pr', 'merge'].includes(action)) ||
          current.mandate.allowedActions.some(action => !request.proposedMandate.allowedActions.includes(action)) ||
          !request.proposedMandate.allowedActions.includes('investigate') ||
          request.proposedMandate.authority.kind !== 'human_approval' ||
          request.proposedMandate.authority.approvalRef !== request.id))
        throw new Error('Scope request is outside supported authority');
      if (request.kind === 'action' && (!['open_pr', 'merge'].includes(request.action) ||
          !current.mandate.allowedActions.includes(request.action) ||
          this.latestReview(current.id)?.id !== request.reviewRecordId))
        throw new Error('Action request is outside the current Task Mandate');
      this.saveRecord({ id: request.id, taskId: request.taskId, kind: 'approval_request', request, status: 'open',
        at: new Date().toISOString() });
    });
  }
  latestReview(taskId: string): Extract<TaskRecord, { kind: 'review' }> | undefined {
    const current = this.getTask(taskId);
    if (!current) return undefined;
    const row = this.db.prepare(`SELECT payload_json FROM task_record WHERE task_id=? AND kind='review'
      ORDER BY at DESC,rowid DESC LIMIT 1`).get(taskId);
    if (!row) return undefined;
    const review = taskRecord.parse(JSON.parse(String(row.payload_json)));
    return review.kind === 'review' && review.iteration === current.iteration ? review : undefined;
  }
  latestReviewedSha(taskId: string): string | undefined {
    const review = this.latestReview(taskId);
    if (!review) return undefined;
    if (!isBlockingReview(review)) return review.subjectSha;
    if (!review.findings.length) return undefined;
    const rows = this.db.prepare(`SELECT payload_json FROM task_record WHERE task_id=?
      AND kind='review_resolution' AND json_extract(payload_json,'$.reviewRecordId')=?`)
      .all(taskId, review.id);
    const resolved = new Set(rows.map(row => {
      const value = taskRecord.parse(JSON.parse(String(row.payload_json)));
      return value.kind === 'review_resolution' ? value.findingIndex : -1;
    }));
    return review.findings.every((_, index) => resolved.has(index) &&
      this.hasPublishedReviewFinding(taskId, review.id, review.subjectSha, index)) ? review.subjectSha : undefined;
  }
  hasPublishedReviewFinding(taskId: string, reviewRecordId: string, subjectSha: string, findingIndex: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM task_record WHERE task_id=? AND kind='review_finding_publication'
      AND json_extract(payload_json,'$.reviewRecordId')=?
      AND json_extract(payload_json,'$.subjectSha')=?
      AND json_extract(payload_json,'$.findingIndex')=? LIMIT 1`)
      .get(taskId, reviewRecordId, subjectSha, findingIndex));
  }
  saveReviewResolution(input: Extract<TaskRecord, { kind: 'review_resolution' }>): boolean {
    const value = taskRecord.parse(input);
    if (value.kind !== 'review_resolution') throw new Error('Review resolution is invalid');
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT payload_json FROM task_record WHERE kind='review_resolution' AND idempotency_key=?")
        .get(value.idempotencyKey);
      if (prior) {
        const record = taskRecord.parse(JSON.parse(String(prior.payload_json)));
        if (record.kind === 'review_resolution' && record.taskId === value.taskId &&
            record.reviewRecordId === value.reviewRecordId && record.findingIndex === value.findingIndex &&
            record.disposition === value.disposition && record.reason === value.reason &&
            record.actor.id === value.actor.id) return this.latestReviewedSha(value.taskId) === value.subjectSha;
        throw new Error('Review resolution idempotency key conflicts');
      }
      const current = this.getTask(value.taskId);
      const review = this.latestReview(value.taskId);
      if (!current || current.state !== 'waiting_human' || !review || !isBlockingReview(review) ||
          review.id !== value.reviewRecordId || review.subjectSha !== value.subjectSha ||
          value.findingIndex >= review.findings.length ||
          !this.hasPublishedReviewFinding(value.taskId, review.id, review.subjectSha, value.findingIndex) ||
          this.db.prepare(`SELECT 1 FROM task_record WHERE task_id=? AND kind='review_resolution'
            AND json_extract(payload_json,'$.reviewRecordId')=?
            AND json_extract(payload_json,'$.findingIndex')=?`).get(value.taskId, value.reviewRecordId, value.findingIndex))
        throw new Error('Review finding is stale or already resolved');
      this.saveRecord(value);
      return this.latestReviewedSha(value.taskId) === value.subjectSha;
    });
  }
  hasActionApproval(input: { taskId: string; action: 'open_pr' | 'merge'; sourceSha: string;
    targetBranch: string; targetSha: string; changeRef?: string; policyVersion: string }): boolean {
    const current = this.getTask(input.taskId);
    const review = this.latestReview(input.taskId);
    if (!current || current.state !== 'ready_to_merge' || !review ||
        current.mandate.policyVersion !== input.policyVersion ||
        !current.mandate.allowedActions.includes(input.action) ||
        this.latestReviewedSha(input.taskId) !== input.sourceSha) return false;
    const rows = this.db.prepare(`SELECT payload_json FROM task_record WHERE task_id=?
      AND kind='approval_request' AND status='approved' ORDER BY at DESC,id DESC`).all(input.taskId);
    return rows.some(row => {
      const record = taskRecord.parse(JSON.parse(String(row.payload_json)));
      if (record.kind !== 'approval_request') return false;
      const request = approvalRequest.parse(record.request);
      if (request.kind !== 'action' || request.action !== input.action ||
          request.sourceSha !== input.sourceSha || request.reviewRecordId !== review.id ||
          request.targetBranch !== input.targetBranch ||
          request.targetSha !== input.targetSha || request.changeRef !== input.changeRef ||
          request.policyVersion !== input.policyVersion) return false;
      const approval = this.db.prepare(`SELECT payload_json FROM task_record WHERE task_id=?
        AND kind='approval' AND json_extract(payload_json,'$.requestId')=? LIMIT 1`)
        .get(input.taskId, request.id);
      if (!approval) return false;
      const decision = taskRecord.parse(JSON.parse(String(approval.payload_json)));
      return decision.kind === 'approval' && decision.decision === 'approve';
    });
  }
  invalidateOpenApprovals(taskId: string, reopeningRecordId: string): void {
    const reopening = this.getRecord(reopeningRecordId);
    if (reopening?.kind !== 'reopen' || reopening.relatedTaskId !== taskId)
      throw new Error('Approval invalidation does not match the investigation transfer');
    for (const row of this.db.prepare("SELECT id FROM task_record WHERE task_id=? AND kind='approval_request' AND status='open'")
      .all(taskId)) {
      const record = this.getRecord(String(row.id));
      if (record?.kind !== 'approval_request' || record.status !== 'open')
        throw new Error('Open approval request changed');
      const changed = this.db.prepare("UPDATE task_record SET status='invalidated',payload_json=? WHERE id=? AND status='open'")
        .run(JSON.stringify({ ...record, status: 'invalidated', invalidatedByReopenId: reopeningRecordId }), record.id);
      if (changed.changes !== 1) throw new Error('Open approval request changed');
    }
  }
  recordApproval(value: z.infer<typeof approvalDecision>): Task | undefined {
    value = approvalDecision.parse(value);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT payload_json FROM task_record WHERE kind='approval' AND idempotency_key=?")
        .get(value.idempotencyKey);
      if (existing) {
        const record = taskRecord.parse(JSON.parse(String(existing.payload_json)));
        if (record.kind === 'approval' && record.requestId === value.requestId &&
            record.actor.id === value.actor.id && record.decision === value.decision) return undefined;
        throw new Error('Idempotency key conflicts with another decision');
      }
      const row = this.db.prepare("SELECT payload_json FROM task_record WHERE id=? AND kind='approval_request'").get(value.requestId);
      if (!row) throw new Error('Approval request is missing');
      const record = taskRecord.parse(JSON.parse(String(row.payload_json)));
      if (record.kind !== 'approval_request' || record.status !== 'open') throw new Error('Approval request is closed');
      const request = approvalRequest.parse(record.request);
      const current = this.getTask(record.taskId);
      const stageFive = request.kind === 'action' || (request.kind === 'scope_change' &&
        request.proposedMandate.allowedActions.some(action => action === 'open_pr' || action === 'merge'));
      const continueRun = request.kind === 'continue'
        ? this.db.prepare("SELECT 1 FROM run WHERE task_id=? AND stage='develop' AND commit_sha=? LIMIT 1")
          .get(request.taskId, request.sourceSha) : undefined;
      if (!current || current.state !== 'waiting_human' ||
          (request.kind !== 'action' && current.iteration !== request.iteration) ||
          (request.kind === 'continue' ? !continueRun
            : stageFive ? this.latestReviewedSha(current.id) !== request.sourceSha : current.baseRef !== request.sourceSha) ||
          (request.kind === 'action' && this.latestReview(current.id)?.id !== request.reviewRecordId) ||
          current.mandate.policyVersion !== request.policyVersion) throw new Error('Approval request is stale');
      this.saveRecord({ id: randomUUID(), taskId: current.id, kind: 'approval', requestId: request.id,
        action: request.kind === 'scope_change' || request.kind === 'continue' ? 'edit' : request.action,
        subjectSha: request.sourceSha,
        policyVersion: request.policyVersion, actor: value.actor, decision: value.decision,
        idempotencyKey: value.idempotencyKey, at: value.at });
      const status = value.decision === 'approve' ? 'approved' : 'rejected';
      this.db.prepare('UPDATE task_record SET status=?,payload_json=? WHERE id=? AND status=?')
        .run(status, JSON.stringify({ ...record, status }), record.id, 'open');
      if (request.kind === 'scope_change' && value.decision === 'approve') {
        const next = task.parse({ ...current, mandate: request.proposedMandate });
        const changed = this.db.prepare('UPDATE task SET mandate=?,payload_json=? WHERE id=? AND state=?')
          .run(JSON.stringify(next.mandate), JSON.stringify(next), current.id, current.state);
        if (changed.changes !== 1) throw new Error('Approval Task state changed');
        return next;
      }
      return (request.kind === 'action' || request.kind === 'continue') && value.decision === 'approve'
        ? current : undefined;
    });
  }
  recordAnswer(value: z.infer<typeof answer>): { task: Task; run: Run } | undefined {
    value = answer.parse(value);
    return this.transaction(() => {
      const duplicate = this.db.prepare("SELECT payload_json FROM task_record WHERE kind='answer' AND idempotency_key=?")
        .get(value.idempotencyKey);
      if (duplicate) {
        const record = taskRecord.parse(JSON.parse(String(duplicate.payload_json)));
        if (record.kind === 'answer' && record.questionId === value.questionId &&
            record.content === value.content && record.actor.id === value.actor.id) return undefined;
        throw new Error('Idempotency key conflicts with another answer');
      }
      const row = this.db.prepare("SELECT payload_json FROM task_record WHERE id=? AND kind='question'").get(value.questionId);
      if (!row) throw new Error('Question is missing');
      const question = taskRecord.parse(JSON.parse(String(row.payload_json)));
      if (question.kind !== 'question' || question.status !== 'open' || !question.runId) throw new Error('Question is closed');
      const current = this.getTask(question.taskId);
      const currentRun = this.getRun(question.runId);
      if (!current || current.state !== 'waiting_human' || !currentRun ||
          currentRun.status !== 'waiting_human' || !currentRun.questionTerminationVerified ||
          currentRun.iteration !== current.iteration)
        throw new Error('Question does not match current Task and Run');
      this.saveRecord({ id: randomUUID(), taskId: current.id, runId: currentRun.id, kind: 'answer',
        questionId: question.id, content: value.content, idempotencyKey: value.idempotencyKey,
        actor: value.actor, status: 'pending', at: new Date().toISOString() });
      this.db.prepare('UPDATE task_record SET status=?,payload_json=? WHERE id=? AND status=?')
        .run('answered', JSON.stringify({ ...question, status: 'answered' }), question.id, 'open');
      return { task: current, run: currentRun };
    });
  }
  setAnswerStatus(recordId: string, from: 'pending', to: 'delivered' | 'uncertain'): void {
    this.transaction(() => {
      const record = this.getRecord(recordId);
      if (!record || record.kind !== 'answer' || record.status !== from) throw new Error('Answer delivery state changed');
      const changed = this.db.prepare('UPDATE task_record SET status=?,payload_json=? WHERE id=? AND status=?')
        .run(to, JSON.stringify({ ...record, status: to }), recordId, from);
      if (changed.changes !== 1) throw new Error('Answer delivery state changed');
    });
  }
  saveTransition(taskId: string, to: TaskState, reason: string, at: string, recordId: string,
    actor: z.infer<typeof actorRef>): TaskTransitionResult {
    return this.transaction(() => {
      const current = this.getTask(taskId);
      if (!current) throw new Error(`Task ${taskId} is missing`);
      const result = transitionTask(current, to, reason, at, recordId, actor);
      const next = task.parse(result.task);
      const changed = this.db.prepare('UPDATE task SET state=?, updated_at=?, payload_json=? WHERE id=? AND state=?')
        .run(next.state, next.updatedAt, JSON.stringify(next), next.id, current.state);
      if (changed.changes !== 1) throw new Error('Task state changed or task is missing');
      this.saveRecord(result.record);
      return result;
    });
  }
  saveRun(input: Run): void {
    const value = run.parse(input);
    this.db.prepare(`INSERT INTO run (id,task_id,iteration,stage,status,request_key,priority,attempt,lease_until,agent_kind,model,session_id,
      workspace_ref,skill_ref,commit_sha,usage,result_ref,created_at,ended_at,payload_json,worker_id,queue_class)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(value.id, value.taskId, value.iteration, value.stage, value.status, value.requestKey ?? null, value.priority,
        value.attempt, value.leaseUntil ?? null, value.agentKind ?? null, value.model ?? null, value.sessionId ?? null,
        value.workspaceRef ?? null, value.skillRef ? JSON.stringify(value.skillRef) : null, value.commitSha ?? null, value.usage ? JSON.stringify(value.usage) : null,
        value.resultRef ?? null, value.createdAt, value.endedAt ?? null, JSON.stringify(value), value.workerId ?? null, value.queueClass ?? 'normal');
  }
  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT payload_json FROM run WHERE id=?').get(id);
    return row ? run.parse(JSON.parse(String(row.payload_json))) : undefined;
  }
  countReviewBlocks(taskId: string, iteration: number): number {
    const rows = this.db.prepare(`SELECT record.payload_json FROM task_record AS record
      JOIN run ON run.id=record.run_id WHERE record.task_id=? AND run.iteration=?
      AND run.stage='review' AND record.kind='review'`).all(taskId, iteration);
    return rows.filter(row => {
      const record = taskRecord.parse(JSON.parse(String(row.payload_json)));
      return record.kind === 'review' && isBlockingReview(record);
    }).length;
  }
  setRepairBaseRef(taskId: string, sourceSha: string): void {
    const current = this.getTask(taskId);
    if (!current || current.state !== 'developing' || !/^[a-f0-9]{40}$/.test(sourceSha))
      throw new Error('Repair base does not match a developing Task');
    const next = task.parse({ ...current, baseRef: sourceSha });
    this.db.prepare('UPDATE task SET base_ref=?,payload_json=? WHERE id=? AND state=?')
      .run(sourceSha, JSON.stringify(next), taskId, 'developing');
  }
  replaceRun(input: Run, expectedStatus: Run['status']): void {
    const value = run.parse(input);
    const current = this.getRun(value.id);
    if (!current || current.status !== expectedStatus || current.taskId !== value.taskId ||
        current.iteration !== value.iteration || current.stage !== value.stage)
      throw new Error('Run changed or is missing');
    const result = this.db.prepare(`UPDATE run SET status=?,attempt=?,lease_until=?,agent_kind=?,session_id=?,workspace_ref=?,
      skill_ref=?,commit_sha=?,usage=?,result_ref=?,ended_at=?,payload_json=?,worker_id=?,queue_class=? WHERE id=? AND status=?`)
      .run(value.status, value.attempt, value.leaseUntil ?? null, value.agentKind ?? null, value.sessionId ?? null,
        value.workspaceRef ?? null, value.skillRef ? JSON.stringify(value.skillRef) : null, value.commitSha ?? null,
        value.usage ? JSON.stringify(value.usage) : null, value.resultRef ?? null, value.endedAt ?? null,
        JSON.stringify(value), value.workerId ?? null, value.queueClass ?? 'normal', value.id, expectedStatus);
    if (result.changes !== 1) throw new Error('Run changed or is missing');
  }
  claimRun(workerId: string, at: string, leaseUntil: string, limits: {
    maxConcurrentRuns: number; perRepoConcurrentRuns: number; perAgentConcurrentRuns: number; reservedHumanResume: number;
  }, agentKinds: readonly string[], stages: readonly Run['stage'][] = ['investigate', 'develop'],
  stageFilter?: (run: Run, task: Task) => boolean): Run | undefined {
    return this.transaction(() => {
      if (this.db.prepare(`SELECT 1 FROM run WHERE status='paused'
        AND json_extract(payload_json,'$.processTerminationUnconfirmed')=1 LIMIT 1`).get()) return undefined;
      const active = this.db.prepare(`SELECT r.task_id,r.session_id,r.agent_kind,r.queue_class,t.repo_key FROM run r
        JOIN task t ON t.id=r.task_id WHERE r.status='running'`).all();
      const queued = this.db.prepare(`SELECT r.id,t.repo_key FROM run r JOIN task t ON t.id=r.task_id
        WHERE r.status='queued'
        ORDER BY (r.queue_class='human_resume') DESC,r.priority DESC,r.created_at,r.id`).all();
      for (const row of queued) {
        const candidate = this.getRun(String(row.id))!;
        if (!stages.includes(candidate.stage)) continue;
        const task = this.getTask(candidate.taskId);
        if (task?.state === 'waiting_human') continue;
        if (task && stageFilter && !stageFilter(candidate, task)) continue;
        if (!candidate.agentKind || !agentKinds.includes(candidate.agentKind) ||
            active.length >= limits.maxConcurrentRuns ||
            ((candidate.queueClass ?? 'normal') === 'normal' && active.filter(item => item.queue_class === 'normal').length >=
              limits.maxConcurrentRuns - limits.reservedHumanResume) ||
            active.filter(item => item.repo_key === row.repo_key).length >= limits.perRepoConcurrentRuns ||
            active.filter(item => item.agent_kind === candidate.agentKind).length >= limits.perAgentConcurrentRuns ||
            active.some(item => item.task_id === candidate.taskId ||
              (candidate.sessionId && item.session_id === candidate.sessionId))) continue;
        const claimed = run.parse({ ...candidate, status: 'running', workerId, attempt: candidate.attempt + 1,
          startedAt: at, leaseUntil, questionTerminationVerified: false });
        this.replaceRun(claimed, 'queued');
        return claimed;
      }
      return undefined;
    });
  }
  renewRunLease(runId: string, workerId: string, leaseUntil: string): void {
    this.transaction(() => {
      const current = this.getRun(runId);
      if (!current || current.status !== 'running' || current.workerId !== workerId) throw new Error('Run lease owner changed');
      this.replaceRun({ ...current, leaseUntil }, 'running');
    });
  }
  saveRecord(input: TaskRecord): void {
    const value = taskRecord.parse(input);
    this.db.prepare('INSERT INTO task_record (id,task_id,run_id,event_id,kind,status,subject_sha,idempotency_key,actor,payload_json,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(value.id, value.taskId, value.runId ?? null, value.eventId ?? null, value.kind,
        'status' in value ? value.status ?? null : null, 'subjectSha' in value ? value.subjectSha ?? null : null,
        'idempotencyKey' in value ? value.idempotencyKey ?? null : null,
        'actor' in value ? JSON.stringify(value.actor) : null, JSON.stringify(value), value.at);
  }
  saveEffectIntent(input: Extract<TaskRecord, { kind: 'effect' }> & { request: NonNullable<Extract<TaskRecord,
    { kind: 'effect' }>['request']> }): Extract<TaskRecord, { kind: 'effect' }> {
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT payload_json FROM task_record WHERE kind='effect' AND idempotency_key=?")
        .get(input.idempotencyKey);
      if (prior) {
        const record = taskRecord.parse(JSON.parse(String(prior.payload_json)));
        if (record.kind !== 'effect' || record.taskId !== input.taskId || record.action !== input.action ||
            JSON.stringify(record.request) !== JSON.stringify(input.request))
          throw new Error('Effect idempotency key conflicts with another request');
        return record;
      }
      if (input.status !== 'pending' || input.subjectSha !== input.request.sourceSha)
        throw new Error('Effect intent must bind its source SHA');
      const owner = this.getTask(input.taskId);
      if (!owner || input.request.repoKey !== owner.repoKey ||
          !owner.mandate.allowedActions.includes(input.action) ||
          owner.mandate.policyVersion !== input.request.policyVersion)
        throw new Error('Effect intent is outside the current Task Mandate');
      this.saveRecord(input);
      return input;
    });
  }
  rearmUncertainEffect(id: string): void {
    this.transaction(() => {
      const record = this.getRecord(id);
      if (record?.kind !== 'effect' || record.action !== 'open_pr' || record.status !== 'uncertain' ||
          !record.request || record.receipt) throw new Error('Effect is not eligible for recovery');
      const next = taskRecord.parse({ ...record, status: 'pending' });
      const changed = this.db.prepare('UPDATE task_record SET status=?,payload_json=? WHERE id=? AND status=?')
        .run('pending', JSON.stringify(next), id, 'uncertain');
      if (changed.changes !== 1) throw new Error('Effect changed before recovery');
    });
  }
  settleEffect(id: string, status: 'done' | 'uncertain' | 'failed',
    receipt?: Extract<TaskRecord, { kind: 'effect' }>['receipt']): void {
    this.transaction(() => {
      const record = this.getRecord(id);
      if (record?.kind !== 'effect' || !['pending', 'uncertain'].includes(record.status) ||
          (status === 'done' && !receipt) || (status !== 'done' && receipt))
        throw new Error('Effect intent cannot be settled with this receipt');
      if (receipt && (!record.request || receipt.observedSourceSha !== record.request.sourceSha ||
          receipt.observedTargetSha !== record.request.targetSha ||
          (record.action === 'merge' && (!receipt.merged || !receipt.mergedSha ||
            receipt.changeId !== record.request.changeId))))
        throw new Error('Effect receipt does not match the intent');
      const next = taskRecord.parse({ ...record, status, receipt });
      const changed = this.db.prepare('UPDATE task_record SET status=?,payload_json=? WHERE id=? AND status=?')
        .run(status, JSON.stringify(next), id, record.status);
      if (changed.changes !== 1) throw new Error('Effect intent changed before settlement');
    });
  }
  setEventLinkStatus(taskId: string, eventId: string, from: 'pending' | 'delivered' | 'uncertain',
    to: 'delivered' | 'handled' | 'uncertain' | 'handback'): void {
    const allowed: Record<typeof from, readonly typeof to[]> = {
      pending: ['delivered', 'uncertain', 'handback'], delivered: ['handled', 'uncertain', 'handback'],
      uncertain: ['handback'],
    };
    if (!allowed[from].includes(to)) throw new Error(`Invalid event delivery transition ${from} -> ${to}`);
    this.transaction(() => {
      const row = this.db.prepare("SELECT id,payload_json FROM task_record WHERE task_id=? AND event_id=? AND kind='event_link'")
        .get(taskId, eventId);
      if (!row) throw new Error('Event link is missing');
      const record = taskRecord.parse(JSON.parse(String(row.payload_json)));
      if (record.kind !== 'event_link' || record.status !== from) throw new Error('Event link status changed');
      const next = { ...record, status: to };
      const result = this.db.prepare('UPDATE task_record SET status=?,payload_json=? WHERE id=? AND status=?')
        .run(to, JSON.stringify(next), row.id, from);
      if (result.changes !== 1) throw new Error('Event link status changed');
    });
  }
  handbackEvent(taskId: string, eventId: string, reason: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT status FROM task_record WHERE task_id=? AND event_id=? AND kind='event_link'")
        .get(taskId, eventId);
      if (!row || !['pending', 'delivered', 'uncertain'].includes(String(row.status))) throw new Error('Event cannot be handed back again');
      this.setEventLinkStatus(taskId, eventId, row.status as 'pending' | 'delivered' | 'uncertain', 'handback');
      const changed = this.db.prepare("UPDATE source_event SET status='pending',routing_data=?,lease_until=NULL WHERE id=? AND status='done'")
        .run(JSON.stringify({ excludedTaskId: taskId, handbackReason: reason }), eventId);
      if (changed.changes !== 1) throw new Error('Event was not routed');
    });
  }
  getRecord(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT payload_json FROM task_record WHERE id=?').get(id);
    return row ? taskRecord.parse(JSON.parse(String(row.payload_json))) : undefined;
  }
  openQuestionForRun(runId: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT id FROM task_record WHERE run_id=? AND kind='question' AND status='open' ORDER BY at,id LIMIT 1")
      .get(runId);
    return row ? this.getRecord(String(row.id)) : undefined;
  }
  hasPendingInput(taskId: string): boolean {
    return this.db.prepare("SELECT 1 FROM task_record WHERE task_id=? AND kind='event_link' AND status='pending' LIMIT 1")
      .get(taskId) !== undefined;
  }
  close(): void { this.db.close(); }
}
