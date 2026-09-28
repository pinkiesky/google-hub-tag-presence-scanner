import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge, Registry } from 'prom-client';

import { validRssi } from '../observations/rssi';
import { PresenceService } from '../presence/presence.service';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly rssi = new Gauge({
    name: 'cat_rssi_dbm',
    help: 'Latest valid RSSI in dBm.',
    labelNames: ['tag', 'source'],
    registers: [this.registry],
  });

  private readonly lastSeen = new Gauge({
    name: 'cat_last_seen_timestamp_seconds',
    help: 'Unix seconds of the latest matched observation.',
    labelNames: ['tag'],
    registers: [this.registry],
  });

  private readonly sourceLastSeen = new Gauge({
    name: 'cat_source_last_seen_timestamp_seconds',
    help: 'Unix seconds of the latest matched observation per source.',
    labelNames: ['tag', 'source'],
    registers: [this.registry],
  });

  private readonly udpReceived = new Counter({
    name: 'cat_udp_packets_received_total',
    help: 'Valid UDP frames accepted in sequence order.',
    labelNames: ['satellite'],
    registers: [this.registry],
  });

  private readonly udpLost = new Counter({
    name: 'cat_udp_packets_lost_total',
    help: 'UDP frames inferred lost from sequence gaps.',
    labelNames: ['satellite'],
    registers: [this.registry],
  });

  private readonly udpStale = new Counter({
    name: 'cat_udp_packets_stale_total',
    help: 'Duplicate or out-of-order UDP frames ignored.',
    labelNames: ['satellite'],
    registers: [this.registry],
  });

  private readonly udpInvalid = new Counter({
    name: 'cat_udp_packets_invalid_total',
    help: 'UDP datagrams rejected as malformed CatTag frames.',
    registers: [this.registry],
  });

  private readonly tags: Set<string>;

  private readonly logger = new Logger(MetricsService.name);

  constructor(presence: PresenceService) {
    this.udpInvalid.inc(0);
    this.tags = new Set(presence.states.keys());

    for (const state of presence.states.values()) {
      if (state.last_seen !== null && Number.isFinite(state.last_seen) && state.last_seen >= 0) {
        this.lastSeen.labels(state.tag_id).set(state.last_seen);

        if (state.source_name !== 'unknown') {
          this.sourceLastSeen.labels(state.tag_id, state.source_name).set(state.last_seen);
        }
      }
    }
  }

  observeTag(tagId: string, rssi: number, timestamp: number, sourceName: string): void {
    if (
      !this.tags.has(tagId) ||
      !Number.isFinite(timestamp) ||
      timestamp < 0 ||
      typeof sourceName !== 'string' ||
      !sourceName.trim()
    ) {
      this.logger.warn('Attempt to log wrong data');

      return;
    }

    this.lastSeen.labels(tagId).set(timestamp);
    this.sourceLastSeen.labels(tagId, sourceName).set(timestamp);

    if (!validRssi(rssi)) {
      return;
    }

    this.rssi.labels(tagId, sourceName).set(rssi);
  }

  recordUdpPacket(satelliteId: number, lost: bigint): void {
    const satellite = String(satelliteId);
    this.udpReceived.labels(satellite).inc();
    this.udpLost.labels(satellite).inc(Number(lost));
  }

  recordUdpStale(satelliteId: number): void {
    this.udpStale.labels(String(satelliteId)).inc();
  }

  recordUdpInvalid(): void {
    this.udpInvalid.inc();
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
