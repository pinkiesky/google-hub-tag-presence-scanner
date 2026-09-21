import { Injectable, Logger } from '@nestjs/common';

import { TrackerConfig } from '../config/config.service';
import { SqliteService } from '../persistence/sqlite.service';
import { Notification, TagState } from '../tags/tag-state';

export const wallTime = (): number => Date.now() / 1000;
export const monotonicTime = (): number => performance.now() / 1000;
export const duration = (seconds: number): string => {
  const minutes = Math.floor(Math.max(0, Math.trunc(seconds)) / 60);

  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};
export const utc = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
export const absenceStart = (state: TagState): number => state.last_seen ?? state.created_at;
@Injectable()
export class PresenceService {
  readonly states: Map<string, TagState>;
  readonly graceUntil: number;
  readonly settings;
  private inflight: number | null = null;
  private readonly samples = new Map<string, Array<{ timestamp: number; rssi: number }>>();
  private readonly logger = new Logger(PresenceService.name);
  constructor(
    readonly store: SqliteService,
    config: TrackerConfig,
  ) {
    this.settings = config.settings;
    this.states = store.load(config.tags, wallTime());
    this.graceUntil = monotonicTime() + this.settings.startupGraceSeconds;

    for (const tag of config.tags) {
      this.samples.set(tag.id, []);
    }

    this.logger.log(`Loaded ${this.states.size} tags`);
  }

  averageRssi(id: string, mono = monotonicTime()): number | null {
    const samples = this.samples.get(id)!;
    let expired = 0;

    while (expired < samples.length && samples[expired].timestamp <= mono - 300) {
      expired++;
    }

    if (expired) {
      samples.splice(0, expired);
    }

    return samples.length
      ? samples.reduce((sum, sample) => sum + sample.rssi, 0) / samples.length
      : null;
  }

  observe(id: string, now: number, rssi: number, mono = monotonicTime()): void {
    this.samples.get(id)!.push({ timestamp: mono, rssi });
    this.averageRssi(id, mono);
    const state = this.states.get(id)!;

    if (state.last_seen !== null && now < state.last_seen) {
      this.logger.warn(`Clock moved backwards for tag ${id}`);
    }

    this.store.db.transaction(() => {
      if (state.missing_since !== null) {
        const pending = this.store.db
          .prepare("SELECT id FROM outbox WHERE tag_id=? AND episode=? AND kind='absence'")
          .get(id, state.episode) as { id: number } | undefined;

        if (state.alert_sent || (pending && pending.id === this.inflight)) {
          this.store.enqueue(
            state,
            'recovery',
            `✓ ${state.name} is detected again.\nAbsent for ${duration(now - absenceStart(state))}.\nRSSI: ${rssi} dBm.`,
          );
          this.logger.log(`Tag recovered: ${id}`);
        } else if (pending) {
          this.store.db.prepare('DELETE FROM outbox WHERE id=?').run(pending.id);
        }

        state.episode++;
      }

      state.last_seen = now;
      state.last_rssi = rssi;
      state.missing_since = null;
      state.alert_sent = false;
      this.store.save(state);
    })();
    this.logger.debug(`Tag matched: ${id} RSSI=${rssi} dBm`);
  }

  tick(now = wallTime(), mono = monotonicTime()): void {
    this.store.db.transaction(() => {
      for (const state of this.states.values()) {
        const absent = now - absenceStart(state);

        if (absent > this.settings.missingAfterSeconds && state.missing_since === null) {
          state.missing_since = absenceStart(state);
          this.logger.log(`Tag became missing: ${state.tag_id}`);
        }

        if (
          mono >= this.graceUntil &&
          absent > this.settings.alertAfterSeconds &&
          !state.alert_sent
        ) {
          const seen =
            state.last_seen === null
              ? 'never (timer starts at first service start)'
              : `${utc(state.last_seen)} UTC`;
          const rssi = state.last_rssi === null ? 'unknown' : `${state.last_rssi} dBm`;
          this.store.enqueue(
            state,
            'absence',
            `⚠ ${state.name} has not been detected for ${duration(absent)}.\nLast seen: ${seen}.\nLast RSSI: ${rssi}.`,
          );
        }

        this.store.save(state);
      }
    })();
  }

  claim(now = wallTime(), mono = monotonicTime()): Notification | null {
    if (mono < this.graceUntil || this.inflight !== null) {
      return null;
    }

    const item = this.store.nextNotification(now, this.states);

    if (item) {
      this.inflight = item.id;
    }

    return item;
  }

  delivered(item: Notification): void {
    const state = this.states.get(item.tag_id)!;
    this.store.db.transaction(() => {
      if (item.kind === 'absence' && state.episode === item.episode) {
        state.alert_sent = true;
        this.store.save(state);
      }

      this.store.db.prepare('DELETE FROM outbox WHERE id=?').run(item.id);
    })();
    this.inflight = null;
    this.logger.log(`${item.kind} notification sent: ${item.tag_id}`);
  }

  failed(item: Notification, now = wallTime(), retryAfter = 0): void {
    const delay = Math.max(retryAfter, Math.min(900, 30 * 2 ** Math.min(item.attempts, 5)));
    this.store.db
      .prepare('UPDATE outbox SET attempts=attempts+1,next_attempt=? WHERE id=?')
      .run(now + delay, item.id);
    this.inflight = null;
  }
}
