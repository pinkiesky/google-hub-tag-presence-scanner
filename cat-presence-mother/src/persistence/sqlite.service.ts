import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Database from 'better-sqlite3';
import { flockSync } from 'fs-ext';

import { TrackerConfig } from '../config/config.service';
import { Tag } from '../tags/tag.types';
import { TagState } from '../tags/tag-state';

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
        // Prevent multiple service processes from sharing the database.
        flockSync(this.lock, 'exnb');
      }

      this.db = new Database(path, { timeout: 5000 });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS states (
          tag_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at REAL NOT NULL,
          last_seen REAL, source_name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS source_states (
          tag_id TEXT NOT NULL, source_name TEXT NOT NULL, last_seen REAL NOT NULL,
          PRIMARY KEY (tag_id, source_name)
        );
        CREATE TABLE IF NOT EXISTS presence_samples (
          sample_id INTEGER PRIMARY KEY, tag_id TEXT NOT NULL, source_name TEXT NOT NULL,
          observed_at REAL NOT NULL, rssi REAL
        );
        CREATE INDEX IF NOT EXISTS presence_samples_time ON presence_samples(observed_at);
        CREATE INDEX IF NOT EXISTS presence_samples_tag_time ON presence_samples(tag_id, observed_at);
      `);
      const columns = this.db.pragma('table_info(states)') as Array<{ name: string }>;

      if (!columns.some((column) => column.name === 'source_name')) {
        this.db.exec("ALTER TABLE states ADD COLUMN source_name TEXT NOT NULL DEFAULT 'unknown'");
      }

      // Enforce the same requirement on databases that already have a nullable column,
      // preserving their existing columns, indexes, and other tables.
      this.db.transaction(() => {
        this.db.exec(`
          UPDATE states SET source_name='unknown'
          WHERE source_name IS NULL OR length(trim(source_name))=0;
          CREATE TRIGGER IF NOT EXISTS states_source_required_insert
          BEFORE INSERT ON states
          WHEN NEW.source_name IS NULL OR length(trim(NEW.source_name))=0
          BEGIN
            SELECT RAISE(ABORT, 'source_name is required');
          END;
          CREATE TRIGGER IF NOT EXISTS states_source_required_update
          BEFORE UPDATE OF source_name ON states
          WHEN NEW.source_name IS NULL OR length(trim(NEW.source_name))=0
          BEGIN
            SELECT RAISE(ABORT, 'source_name is required');
          END;
        `);
      })();
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
            const row = this.db
              .prepare(
                'SELECT tag_id,name,created_at,last_seen,source_name FROM states WHERE tag_id=?',
              )
              .get(tag.id) as TagState | undefined;
            const state: TagState = row
              ? { ...row, name: tag.name }
              : {
                  tag_id: tag.id,
                  name: tag.name,
                  created_at: now,
                  last_seen: null,
                  source_name: 'unknown',
                };
            this.save(state);

            if (state.last_seen !== null && state.source_name !== 'unknown') {
              this.db
                .prepare(
                  'INSERT OR IGNORE INTO source_states (tag_id,source_name,last_seen) VALUES (?,?,?)',
                )
                .run(tag.id, state.source_name, state.last_seen);
            }

            return [tag.id, state];
          }),
        ),
    )();
  }

  save(state: TagState): void {
    this.db
      .prepare(
        `INSERT INTO states (tag_id,name,created_at,last_seen,source_name)
         VALUES (@tag_id,@name,@created_at,@last_seen,@source_name)
         ON CONFLICT(tag_id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen,source_name=excluded.source_name`,
      )
      .run(state);
  }

  getSourceLastSeen(): Array<{ tagId: string; name: string; lastSeen: number }> {
    return this.db
      .prepare(
        'SELECT tag_id AS tagId, source_name AS name, last_seen AS lastSeen FROM source_states',
      )
      .all() as Array<{ tagId: string; name: string; lastSeen: number }>;
  }

  recordObservation(state: TagState, rssi: number | null, windowSeconds: number): void {
    this.db.transaction(() => {
      this.save(state);
      this.db
        .prepare(
          `INSERT INTO source_states (tag_id,source_name,last_seen) VALUES (?,?,?)
           ON CONFLICT(tag_id,source_name) DO UPDATE SET last_seen=excluded.last_seen`,
        )
        .run(state.tag_id, state.source_name, state.last_seen);
      this.db
        .prepare(
          'INSERT INTO presence_samples (tag_id,source_name,observed_at,rssi) VALUES (?,?,?,?)',
        )
        .run(state.tag_id, state.source_name, state.last_seen, rssi);
      this.db
        .prepare('DELETE FROM presence_samples WHERE observed_at < ?')
        .run(state.last_seen! - windowSeconds);
    })();
  }

  getSourceWindows(
    tagId: string,
    now: number,
    windowSeconds: number,
  ): Array<{
    name: string;
    lastSeen: number;
    averageSignalDbm: number | null;
    maxSignalDbm: number | null;
  }> {
    return this.db
      .prepare(
        `SELECT sources.source_name AS name, sources.last_seen AS lastSeen,
                AVG(samples.rssi) AS averageSignalDbm, MAX(samples.rssi) AS maxSignalDbm
         FROM source_states AS sources
         LEFT JOIN presence_samples AS samples
           ON samples.tag_id=sources.tag_id AND samples.source_name=sources.source_name
           AND samples.observed_at >= ? AND samples.observed_at <= ?
         WHERE sources.tag_id=?
         GROUP BY sources.source_name
         ORDER BY sources.source_name`,
      )
      .all(now - windowSeconds, now, tagId) as Array<{
      name: string;
      lastSeen: number;
      averageSignalDbm: number | null;
      maxSignalDbm: number | null;
    }>;
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
