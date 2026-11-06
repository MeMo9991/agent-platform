export const schemaVersion = 4;
export const initialSchema = `
CREATE TABLE event_source (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, config_ref TEXT NOT NULL,
  cursor TEXT, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE source_event (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, revision TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, thread_key TEXT, object_key TEXT,
  repo_key TEXT, url TEXT, occurred_at TEXT, attachments_json TEXT NOT NULL, meta_data TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','routing','needs_human','done')),
  lease_until TEXT, routing_data TEXT, received_at TEXT NOT NULL,
  UNIQUE(source_id,external_id,revision)
);
CREATE INDEX source_event_object ON source_event(source_id,object_key);
CREATE INDEX source_event_pending ON source_event(status,lease_until);
CREATE TABLE task (
  id TEXT PRIMARY KEY, origin_event_id TEXT UNIQUE, repo_key TEXT NOT NULL, title TEXT NOT NULL,
  scope TEXT NOT NULL, mandate TEXT NOT NULL, state TEXT NOT NULL, iteration INTEGER NOT NULL CHECK(iteration>=1),
  priority INTEGER NOT NULL, owner TEXT, base_ref TEXT, parent_task_id TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE TABLE subscription (
  task_id TEXT NOT NULL, source_id TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('thread','object')),
  target_key TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('handle','context')),
  PRIMARY KEY(task_id,source_id,target_kind,target_key)
);
CREATE INDEX subscription_target ON subscription(source_id,target_kind,target_key);
CREATE TABLE run (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, iteration INTEGER NOT NULL CHECK(iteration>=1), stage TEXT NOT NULL,
  status TEXT NOT NULL, request_key TEXT UNIQUE, priority INTEGER NOT NULL, attempt INTEGER NOT NULL,
  lease_until TEXT, agent_kind TEXT, model TEXT, session_id TEXT, workspace_ref TEXT, skill_ref TEXT,
  commit_sha TEXT, usage TEXT, result_ref TEXT, created_at TEXT NOT NULL, ended_at TEXT, payload_json TEXT NOT NULL
);
CREATE INDEX run_queue ON run(status,stage,priority);
CREATE TABLE task_record (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, event_id TEXT, kind TEXT NOT NULL,
  status TEXT, subject_sha TEXT, idempotency_key TEXT, actor TEXT, payload_json TEXT NOT NULL, at TEXT NOT NULL
);
CREATE UNIQUE INDEX task_record_event_link ON task_record(task_id,event_id) WHERE kind='event_link';
CREATE UNIQUE INDEX task_record_effect_key ON task_record(idempotency_key) WHERE kind='effect';
CREATE INDEX task_record_timeline ON task_record(task_id,at);
`;
