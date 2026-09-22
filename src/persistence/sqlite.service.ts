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
          last_seen REAL
        );
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
            const row = this.db
              .prepare('SELECT tag_id,name,created_at,last_seen FROM states WHERE tag_id=?')
              .get(tag.id) as TagState | undefined;
            const state: TagState = row
              ? { ...row, name: tag.name }
              : {
                  tag_id: tag.id,
                  name: tag.name,
                  created_at: now,
                  last_seen: null,
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
        `INSERT INTO states (tag_id,name,created_at,last_seen)
         VALUES (@tag_id,@name,@created_at,@last_seen)
         ON CONFLICT(tag_id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen`,
      )
      .run(state);
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
