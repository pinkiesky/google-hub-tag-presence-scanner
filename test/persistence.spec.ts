import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { manager } from './helpers';

test('loads persisted state and pending outbox without resetting clocks or alerts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cat-persisted-db-'));
  const database = join(directory, 'presence.sqlite3');
  const db = new Database(database);
  db.exec(readFileSync(join(__dirname, 'fixtures/persisted-state.sql'), 'utf8'));
  db.close();
  const m = manager({ database });

  try {
    expect(m.states.get('a')).toMatchObject({
      created_at: 0,
      last_seen: 100,
      last_rssi: -63,
      missing_since: 100,
      alert_sent: true,
    });
    expect(m.states.get('b')!.created_at).toBe(0);
    const pending = m.claim(3800, m.graceUntil)!;
    expect(pending).toMatchObject({ tag_id: 'b', kind: 'absence', attempts: 0 });
    expect(pending.message).toContain('never (timer starts at first service start)');
    m.delivered(pending);
    expect(m.store.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(m.store.db.pragma('synchronous', { simple: true })).toBe(2);
    expect(m.store.db.pragma('user_version', { simple: true })).toBe(1);
  } finally {
    m.store.onApplicationShutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});
