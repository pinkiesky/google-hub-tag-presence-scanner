import { Injectable, Logger } from '@nestjs/common';

import { TrackerConfig } from '../config/config.service';
import { SqliteService } from '../persistence/sqlite.service';
import { TagState } from '../tags/tag-state';
import { wallTime } from '../util/time';

export interface CatStatus {
  id: string;
  name: string;
  present: boolean;
  signalDbm: number | null;
}

@Injectable()
export class PresenceService {
  readonly states: Map<string, TagState>;
  readonly settings;
  private readonly latestRssi = new Map<string, number | null>();
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
    return [...this.states.values()].map((state) => {
      const present =
        state.last_seen !== null && now - state.last_seen <= this.settings.missingAfterSeconds;

      return {
        id: state.tag_id,
        name: state.name,
        present,
        signalDbm: present ? (this.latestRssi.get(state.tag_id) ?? null) : null,
      };
    });
  }

  observe(id: string, now: number, rssi: number | null): void {
    this.latestRssi.set(id, rssi);
    const state = this.states.get(id)!;

    if (state.last_seen !== null && now < state.last_seen) {
      this.logger.warn(`Clock moved backwards for tag ${id}`);
    }

    state.last_seen = now;
    this.store.save(state);
  }
}
