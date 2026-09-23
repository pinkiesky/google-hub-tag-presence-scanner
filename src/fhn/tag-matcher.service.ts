import { Inject, Injectable } from '@nestjs/common';

import { TrackerConfig } from '../config/config.service';
import { TagObservationService } from '../observations/tag-observation.service';
import { EidService, ROTATION_SECONDS } from './eid.service';

@Injectable()
export class TagMatcherService {
  private windows: number[] = [];
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly config: TrackerConfig,
    private readonly eid: EidService,
    @Inject(TagObservationService)
    private readonly observations: Pick<TagObservationService, 'observe'>,
  ) {}

  observe(eid: Buffer, rssi: number, timestamp: number): string | null {
    const tagId = this.match(eid, timestamp);

    if (tagId !== null) {
      this.observations.observe({ tagId, rssi, timestamp });
    }

    return tagId;
  }

  private refresh(now: number): void {
    const windows = this.config.tags.map((t) =>
      Math.floor(Math.trunc(now - t.pairDate + t.clockOffsetSeconds) / ROTATION_SECONDS),
    );

    if (windows.length === this.windows.length && windows.every((w, i) => w === this.windows[i])) {
      return;
    }

    this.cache.clear();
    this.config.tags.forEach((tag, i) => {
      for (
        let delta = -this.config.settings.driftWindows;
        delta <= this.config.settings.driftWindows;
        delta++
      ) {
        for (const size of [20, 32]) {
          const eid = this.eid
            .calculate(tag.eik, (windows[i] + delta) * ROTATION_SECONDS, size)
            .toString('hex');
          this.cache.set(eid, tag.id);
        }
      }
    });
    this.windows = windows;
  }

  match(eid: Buffer, now: number): string | null {
    this.refresh(now);

    return this.cache.get(eid.toString('hex')) ?? null;
  }
}
