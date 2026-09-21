import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Database from 'better-sqlite3';
import { flockSync } from 'fs-ext';

import { TrackerConfig } from '../config/config.service';
import { Tag } from '../tags/tag.types';
import { Notification, TagState } from '../tags/tag-state';

@Injectable()
export class SqliteService implements OnApplicationShutdown {
  readonly db: Database.Database;
  private lock?: number;
  constructor(config: TrackerConfig) {
    const path = config.settings.database;

    try {
      if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.lock = openSync(`${path}.lock`, 'a', 0o600);
        // Same flock as Python: mutually exclusive even during migration.
        flockSync(this.lock, 'exnb');
      }

      this.db = new Database(path, { timeout: 5000 });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS states (
          tag_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at REAL NOT NULL,
          last_seen REAL, last_rssi INTEGER, alert_sent INTEGER NOT NULL DEFAULT 0,
          missing_since REAL, episode INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT, tag_id TEXT NOT NULL,
          episode INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
          UNIQUE(tag_id, episode, kind)
        ); PRAGMA user_version=1;
      `);
    } catch {
      if (this.lock !== undefined) {
        closeSync(this.lock);
      }

      throw new Error('Cannot open SQLite database or acquire exclusive service lock');
    }

    new Logger('SqliteService').log('SQLite opened');
  }

  load(tags: readonly Tag[], now: number): Map<string, TagState> {
    return this.db.transaction(
      () =>
        new Map(
          tags.map((tag) => {
            const row = this.db.prepare('SELECT * FROM states WHERE tag_id=?').get(tag.id) as
              TagState | undefined;
            const state: TagState = row
              ? { ...row, name: tag.name, alert_sent: Boolean(row.alert_sent) }
              : {
                  tag_id: tag.id,
                  name: tag.name,
                  created_at: now,
                  last_seen: null,
                  last_rssi: null,
                  alert_sent: false,
                  missing_since: null,
                  episode: 0,
                };
            this.save(state);

            return [tag.id, state];
          }),
        ),
    )();
  }

  save(state: TagState): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO states
      (tag_id,name,created_at,last_seen,last_rssi,alert_sent,missing_since,episode)
      VALUES (@tag_id,@name,@created_at,@last_seen,@last_rssi,@alert_sent,@missing_since,@episode)`,
      )
      .run({ ...state, alert_sent: Number(state.alert_sent) });
  }

  enqueue(state: TagState, kind: Notification['kind'], message: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO outbox(tag_id,episode,kind,message) VALUES(?,?,?,?)')
      .run(state.tag_id, state.episode, kind, message);
  }

  nextNotification(now: number, active: ReadonlyMap<string, TagState>): Notification | null {
    const rows = this.db
      .prepare(
        `SELECT id,tag_id,episode,kind,message,attempts FROM outbox o
      WHERE next_attempt <= ? AND NOT EXISTS (
        SELECT 1 FROM outbox older WHERE older.tag_id=o.tag_id AND older.id<o.id
      ) ORDER BY id`,
      )
      .iterate(now) as IterableIterator<Notification>;

    for (const row of rows) {
      if (active.has(row.tag_id)) {
        return row;
      }
    }

    return null;
  }

  onApplicationShutdown(): void {
    if (this.db.open) {
      this.db.close();
    }

    if (this.lock !== undefined) {
      closeSync(this.lock);
      this.lock = undefined;
    }
  }
}
