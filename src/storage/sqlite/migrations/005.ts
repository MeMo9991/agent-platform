export const migration5 = `
ALTER TABLE task ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);
CREATE TRIGGER task_version_update AFTER UPDATE ON task
WHEN NEW.version = OLD.version
BEGIN
  UPDATE task SET version = OLD.version + 1 WHERE id = NEW.id;
END;
CREATE INDEX task_list ON task(updated_at DESC,id);
CREATE INDEX source_event_list ON source_event(received_at DESC,id);
CREATE TABLE dashboard_command (
  idempotency_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL, task_id TEXT NOT NULL,
  kind TEXT NOT NULL, reason TEXT NOT NULL, task_version INTEGER NOT NULL
);
`;
