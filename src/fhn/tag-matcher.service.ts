import { Injectable, Logger } from '@nestjs/common';
import { TrackerConfig } from '../config/config.service';
import { EidService, ROTATION_SECONDS } from './eid.service';
@Injectable()
export class TagMatcherService {
  private windows: number[] = [];
  private cache = new Map<string, string | null>();
  constructor(
    private readonly config: TrackerConfig,
    private readonly eid: EidService,
  ) {}
  refresh(now: number): void {
    const windows = this.config.tags.map((t) =>
      Math.floor(Math.trunc(now - t.pairDate + t.clockOffsetSeconds) / ROTATION_SECONDS),
    );
    if (windows.length === this.windows.length && windows.every((w, i) => w === this.windows[i]))
      return;
    const cache = new Map<string, string | null>();
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
          cache.set(eid, cache.has(eid) ? null : tag.id);
        }
      }
    });
    this.cache = cache;
    this.windows = windows;
    new Logger(TagMatcherService.name).debug('EID cache refreshed');
  }
  match(eid: Buffer): string | null {
    return this.cache.get(eid.toString('hex')) ?? null;
  }
}
