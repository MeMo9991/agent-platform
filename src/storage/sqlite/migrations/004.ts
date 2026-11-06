export const migration4 = `
CREATE UNIQUE INDEX task_record_reopen_key ON task_record(kind,idempotency_key)
  WHERE kind='reopen' AND idempotency_key IS NOT NULL;
`;
