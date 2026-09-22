import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { manager } from './helpers';

test('loads legacy database presence without exposing or modifying obsolete state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cat-persisted-db-'));
  const database = join(directory, 'presence.sqlite3');
  const db = new Database(database);
  db.exec(readFileSync(join(__dirname, 'fixtures/persisted-state.sql'), 'utf8'));
  db.close();
  const m = manager({ database });

  try {
    expect(m.states.get('a')).toEqual({
      tag_id: 'a',
      name: 'Cat A',
      created_at: 0,
      last_seen: 100,
    });
    expect(m.states.get('b')!.last_seen).toBeNull();
    const legacy = m.store.db.prepare('SELECT * FROM outbox').all();
    m.observe('a', 3800, -70);
    expect(m.store.db.prepare('SELECT * FROM outbox').all()).toEqual(legacy);
    expect(m.store.db.prepare('SELECT last_seen FROM states WHERE tag_id=?').get('a')).toEqual({
      last_seen: 3800,
    });
    expect(m.store.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(m.store.db.pragma('synchronous', { simple: true })).toBe(2);
  } finally {
    m.store.onApplicationShutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('new databases store only presence and do not persist RSSI', () => {
  const m = manager();

  try {
    const tables = m.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables).toEqual([{ name: 'states' }]);
    m.observe('a', 100, -63);
    expect(m.store.db.prepare('SELECT * FROM states WHERE tag_id=?').get('a')).toEqual({
      tag_id: 'a',
      name: 'Cat A',
      created_at: m.states.get('a')!.created_at,
      last_seen: 100,
    });
  } finally {
    m.store.onApplicationShutdown();
  }
});
