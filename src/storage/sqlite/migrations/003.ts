export const migration3 = `CREATE INDEX task_candidate ON task(repo_key,updated_at DESC,id);`;
