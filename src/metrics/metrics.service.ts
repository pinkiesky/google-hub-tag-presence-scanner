import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Registry } from 'prom-client';

import { validRssi } from '../observations/rssi';
import { PresenceService } from '../presence/presence.service';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly rssi = new Gauge({
    name: 'cat_rssi_dbm',
    help: 'Latest valid RSSI in dBm.',
    labelNames: ['tag'],
    registers: [this.registry],
  });

  private readonly samples = new Counter({
    name: 'cat_rssi_samples_total',
    help: 'Number of valid RSSI observations.',
    labelNames: ['tag'],
    registers: [this.registry],
  });

  private readonly offsetSum = new Counter({
    name: 'cat_rssi_offset_sum_total',
    help: 'Sum of valid RSSI observations plus 120 per sample.',
    labelNames: ['tag'],
    registers: [this.registry],
  });

  private readonly lastSeen = new Gauge({
    name: 'cat_last_seen_timestamp_seconds',
    help: 'Unix seconds of the latest matched observation.',
    labelNames: ['tag'],
    registers: [this.registry],
  });

  private readonly tags: Set<string>;

  constructor(presence: PresenceService) {
    this.tags = new Set(presence.states.keys());

    for (const state of presence.states.values()) {
      this.samples.labels(state.tag_id).inc(0);
      this.offsetSum.labels(state.tag_id).inc(0);

      if (state.last_seen !== null && Number.isFinite(state.last_seen) && state.last_seen >= 0) {
        this.lastSeen.labels(state.tag_id).set(state.last_seen);
      }
    }
  }

  observeTag(tagId: string, rssi: number, timestamp: number): void {
    if (!this.tags.has(tagId) || !Number.isFinite(timestamp) || timestamp < 0) {
      return;
    }

    this.lastSeen.labels(tagId).set(timestamp);

    if (!validRssi(rssi)) {
      return;
    }

    this.rssi.labels(tagId).set(rssi);
    this.samples.labels(tagId).inc();
    this.offsetSum.labels(tagId).inc(rssi + 120);
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
