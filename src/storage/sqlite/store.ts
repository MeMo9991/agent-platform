import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { normalizedEvent, sourceEvent, validateMetadataFields, type EventRepository, type MetadataFields, type NormalizedEvent, type SourceEvent } from '../../event/model.js';
import { task, taskRecord, type Task, type TaskRecord } from '../../agent/task/model.js';
import { transitionTask } from '../../agent/task/transition.js';
import type { TaskTransitionResult } from '../../agent/task/transition.js';
import type { z } from 'zod';
import type { actorRef } from '../../shared/model.js';
import type { TaskState } from '../../agent/task/model.js';
import { run, type Run } from '../../agent/worker/model.js';
import { schemaVersion, initialSchema } from './migrations/001.js';

export class SqliteStore implements EventRepository {
  readonly db: DatabaseSync;
  constructor(path: string, private readonly allowedMetaDataFields: MetadataFields = {}) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA foreign_keys=ON');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (version > schemaVersion) throw new Error(`Unsupported future database version ${version}`);
      if (version < schemaVersion) this.transaction(() => {
        this.db.exec(initialSchema);
        this.db.exec(`PRAGMA user_version=${schemaVersion}`);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  accept(input: NormalizedEvent): { eventId: string; duplicate: boolean } {
    const value = normalizedEvent.parse(input);
    validateMetadataFields(value, this.allowedMetaDataFields);
    return this.transaction(() => {
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
  saveTask(input: Task): void {
    const value = task.parse(input);
    if (value.mandate.authority.kind !== 'trusted_rule') throw new Error('Human-approved Mandate requires a verified authorization service');
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
      workspace_ref,skill_ref,commit_sha,usage,result_ref,created_at,ended_at,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(value.id, value.taskId, value.iteration, value.stage, value.status, value.requestKey ?? null, value.priority,
        value.attempt, value.leaseUntil ?? null, value.agentKind ?? null, value.model ?? null, value.sessionId ?? null,
        value.workspaceRef ?? null, value.skillRef ? JSON.stringify(value.skillRef) : null, value.commitSha ?? null, value.usage ? JSON.stringify(value.usage) : null,
        value.resultRef ?? null, value.createdAt, value.endedAt ?? null, JSON.stringify(value));
  }
  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT payload_json FROM run WHERE id=?').get(id);
    return row ? run.parse(JSON.parse(String(row.payload_json))) : undefined;
  }
  saveRecord(input: TaskRecord): void {
    const value = taskRecord.parse(input);
    this.db.prepare('INSERT INTO task_record (id,task_id,run_id,event_id,kind,status,subject_sha,idempotency_key,actor,payload_json,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(value.id, value.taskId, value.runId ?? null, value.eventId ?? null, value.kind,
        'status' in value ? value.status ?? null : null, 'subjectSha' in value ? value.subjectSha ?? null : null,
        'idempotencyKey' in value ? value.idempotencyKey ?? null : null,
        'actor' in value ? JSON.stringify(value.actor) : null, JSON.stringify(value), value.at);
  }
  getRecord(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT payload_json FROM task_record WHERE id=?').get(id);
    return row ? taskRecord.parse(JSON.parse(String(row.payload_json))) : undefined;
  }
  close(): void { this.db.close(); }
}
