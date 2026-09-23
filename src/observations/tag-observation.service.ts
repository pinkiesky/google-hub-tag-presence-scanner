import { Injectable, Logger } from '@nestjs/common';

import { MetricsService } from '../metrics/metrics.service';
import { PresenceService } from '../presence/presence.service';
import { validRssi } from './rssi';

export interface TagObservation {
  tagId: string;
  rssi: number;
  timestamp: number; // Unix seconds, matching persisted presence timestamps.
}

@Injectable()
export class TagObservationService {
  private readonly logger = new Logger(TagObservationService.name);

  constructor(
    private readonly presence: PresenceService,
    private readonly metrics: MetricsService,
  ) {}

  observe(observation: TagObservation): void {
    const { tagId, rssi, timestamp } = observation;

    if (!this.presence.ifTagExists(tagId)) {
      this.logger.log(`Logger ${tagId} not found`);

      return;
    }

    if (!Number.isFinite(timestamp) || timestamp < 0) {
      return;
    }

    this.presence.observe(tagId, timestamp, validRssi(rssi) ? rssi : null);
    this.metrics.observeTag(tagId, rssi, timestamp);
  }
}
