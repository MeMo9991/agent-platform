import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialSchema } from '../src/storage/sqlite/migrations/001.js';
import { migration2 } from '../src/storage/sqlite/migrations/002.js';
import { migration3 } from '../src/storage/sqlite/migrations/003.js';
import { SqliteStore } from '../src/storage/sqlite/store.js';

test('stage three migration upgrades an existing version-one database in place', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-v1-'));
  const path = join(directory, 'old.sqlite3');
  const old = new DatabaseSync(path);
  try {
    old.exec(initialSchema);
    old.exec('PRAGMA user_version=1');
    old.prepare('INSERT INTO event_source(id,kind,config_ref,enabled) VALUES (?,?,?,?)')
      .run('old-source', 'fixture', 'fixture', 1);
  } finally { old.close(); }
  const upgraded = new SqliteStore(path);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, 5);
    assert.equal(upgraded.db.prepare('SELECT id FROM event_source').get()?.id, 'old-source');
    assert.ok(upgraded.db.prepare("PRAGMA table_info(run)").all().some(row => row.name === 'worker_id'));
  } finally { upgraded.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('reopen idempotency index upgrades an existing version-three database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-v3-'));
  const path = join(directory, 'old.sqlite3');
  const old = new DatabaseSync(path);
  try {
    old.exec(initialSchema);
    old.exec(migration2);
    old.exec(migration3);
    old.exec('PRAGMA user_version=3');
    old.prepare('INSERT INTO event_source(id,kind,config_ref,enabled) VALUES (?,?,?,?)')
      .run('old-source', 'fixture', 'fixture', 1);
  } finally { old.close(); }
  const upgraded = new SqliteStore(path);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, 5);
    assert.equal(upgraded.db.prepare('SELECT id FROM event_source').get()?.id, 'old-source');
    assert.ok(upgraded.db.prepare('PRAGMA index_list(task_record)').all()
      .some(row => row.name === 'task_record_reopen_key'));
  } finally { upgraded.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('candidate index upgrades an existing version-two database without losing data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-v2-'));
  const path = join(directory, 'old.sqlite3');
  const old = new DatabaseSync(path);
  try {
    old.exec(initialSchema);
    old.exec(migration2);
    old.exec('PRAGMA user_version=2');
    old.prepare('INSERT INTO event_source(id,kind,config_ref,enabled) VALUES (?,?,?,?)')
      .run('old-source', 'fixture', 'fixture', 1);
  } finally { old.close(); }
  const upgraded = new SqliteStore(path);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, 5);
    assert.equal(upgraded.db.prepare('SELECT id FROM event_source').get()?.id, 'old-source');
    assert.ok(upgraded.db.prepare("PRAGMA index_list(task)").all().some(row => row.name === 'task_candidate'));
  } finally { upgraded.close(); rmSync(directory, { recursive: true, force: true }); }
});
