import { Injectable, Logger } from '@nestjs/common';

import { TrackerConfig } from '../config/config.service';
import { validRssi } from '../observations/rssi';
import { SqliteService } from '../persistence/sqlite.service';
import { TagState } from '../tags/tag-state';
import { wallTime } from '../util/time';

export interface SourceStatus {
  name: string;
  present: boolean;
  averageSignalDbm: number | null;
}

export interface CatStatus {
  id: string;
  name: string;
  present: boolean;
  maxSignalDbm: number | null;
  sources: SourceStatus[];
}

@Injectable()
export class PresenceService {
  readonly states: Map<string, TagState>;
  readonly settings;
  private readonly logger = new Logger(PresenceService.name);
  constructor(
    readonly store: SqliteService,
    config: TrackerConfig,
  ) {
    this.settings = config.settings;
    this.states = store.load(config.tags, wallTime());

    this.logger.log(`Loaded ${this.states.size} tags`);
  }

  getAllStatuses(now = wallTime()): CatStatus[] {
    const window = this.settings.missingAfterSeconds;

    return [...this.states.values()].map((state) => {
      const present = state.last_seen !== null && now - state.last_seen <= window;
      const sourceWindows = this.store.getSourceWindows(state.tag_id, now, window);

      return {
        id: state.tag_id,
        name: state.name,
        present,
        maxSignalDbm: present
          ? sourceWindows.reduce<number | null>(
              (max, source) =>
                source.maxSignalDbm === null
                  ? max
                  : max === null
                    ? source.maxSignalDbm
                    : Math.max(max, source.maxSignalDbm),
              null,
            )
          : null,
        sources: sourceWindows.map((source) => {
          const sourcePresent = now - source.lastSeen <= window;

          return {
            name: source.name,
            present: sourcePresent,
            averageSignalDbm: sourcePresent ? source.averageSignalDbm : null,
          };
        }),
      };
    });
  }

  observe(id: string, now: number, rssi: number, sourceName: string): void {
    if (typeof sourceName !== 'string' || !sourceName.trim()) {
      throw new Error('sourceName is required');
    }

    const state = this.states.get(id)!;

    if (state.last_seen !== null && now < state.last_seen) {
      this.logger.warn(`Clock moved backwards for tag ${id}`);
    }

    const nextState = { ...state, last_seen: now, source_name: sourceName };
    this.store.recordObservation(
      nextState,
      validRssi(rssi) ? rssi : null,
      this.settings.missingAfterSeconds,
    );
    Object.assign(state, nextState);
  }

  ifTagExists(id: string): boolean {
    return this.states.has(id);
  }
}
