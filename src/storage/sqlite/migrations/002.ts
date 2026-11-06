export const migration2 = `
CREATE INDEX source_event_route_lease ON source_event(status,lease_until,received_at);
CREATE INDEX task_record_delivery ON task_record(task_id,kind,status,at);
CREATE UNIQUE INDEX task_record_human_key ON task_record(kind,idempotency_key)
  WHERE kind IN ('answer','approval') AND idempotency_key IS NOT NULL;
CREATE INDEX run_claim ON run(status,stage,priority,created_at);
ALTER TABLE run ADD COLUMN worker_id TEXT;
ALTER TABLE run ADD COLUMN queue_class TEXT NOT NULL DEFAULT 'normal';
`;
