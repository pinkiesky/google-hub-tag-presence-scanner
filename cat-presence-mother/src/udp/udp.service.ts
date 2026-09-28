import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';

import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';

import { TrackerConfig } from '../config/config.service';
import { FhnParserService } from '../fhn/fhn-parser.service';
import { TagMatcherService } from '../fhn/tag-matcher.service';
import { LifecycleService } from '../lifecycle.service';
import { MetricsService } from '../metrics/metrics.service';
import { wallTime } from '../util/time';
import { CattagFrameError, parseCattagFrame } from './cattag-frame';

const PREVIEW_BYTES = 64;

@Injectable()
export class UdpService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(UdpService.name);
  private socket?: Socket;
  private closing = false;
  private failed = false;
  private readonly sequences = new Map<string, bigint>();

  constructor(
    private readonly config: TrackerConfig,
    private readonly lifecycle: LifecycleService,
    private readonly parser: FhnParserService,
    private readonly matcher: TagMatcherService,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const socket = createSocket('udp4');
    this.socket = socket;
    socket.on('message', (data: Buffer, peer: RemoteInfo) => this.accept(data, peer));

    await new Promise<void>((resolve, reject) => {
      let listening = false;
      socket.on('error', () => {
        if (!listening) {
          reject(new Error('UDP listener failed to bind'));
        } else if (!this.closing) {
          this.lifecycle.fail('UDP listener failed');
        }
      });
      socket.once('listening', () => {
        listening = true;
        resolve();
      });
      socket.bind(this.config.settings.udpPort, '0.0.0.0');
    });

    this.logger.log(`UDP listener started on port ${this.config.settings.udpPort}`);
  }

  accept(data: Buffer, peer: Pick<RemoteInfo, 'address' | 'port'>): void {
    if (this.closing || this.failed) {
      return;
    }

    try {
      const frame = parseCattagFrame(data);
      const preview = frame.serviceData.subarray(0, PREVIEW_BYTES).toString('hex');
      const suffix = frame.serviceData.length > PREVIEW_BYTES ? '…' : '';
      this.logger.log(
        `CatTag UDP from ${peer.address}:${peer.port}: satelliteId=${frame.satelliteId} bootId=0x${frame.bootId.toString(16).padStart(16, '0')} sequence=${frame.sequence} uuid=feaa address=${frame.address.toString('hex')} rssi=${frame.rssi} dataLength=${frame.serviceData.length} serviceData=${preview}${suffix}`,
      );
      const eid = this.parser.parse([{ uuid: 'feaa', data: frame.serviceData }]);

      if (!eid) {
        return;
      }

      const session = `${frame.satelliteId}:${frame.bootId}`;
      const previous = this.sequences.get(session);

      if (previous !== undefined && frame.sequence <= previous) {
        this.metrics.recordUdpStale(frame.satelliteId);

        return;
      }

      this.sequences.set(session, frame.sequence);
      // The first frame of a session has no baseline, so it cannot reveal earlier losses.
      this.metrics.recordUdpPacket(
        frame.satelliteId,
        previous === undefined ? 0n : frame.sequence - previous - 1n,
      );

      const tagId = this.matcher.observe(
        eid,
        frame.rssi,
        wallTime(),
        `satellite:${frame.satelliteId}`,
      );
      const tag = this.config.tags.find((tag) => tag.id === tagId);
      this.logger.log(
        `CatTag UDP observation: matched=${tagId !== null} tagId=${tagId ?? 'unknown'} tagName=${JSON.stringify(tag?.name ?? 'unknown')} rssi=${frame.rssi} satelliteId=${frame.satelliteId} sequence=${frame.sequence}`,
      );
    } catch (error) {
      if (error instanceof CattagFrameError) {
        this.metrics.recordUdpInvalid();
        this.logger.warn(
          `Invalid CatTag UDP from ${peer.address}:${peer.port}: ${data.length} bytes, ${error.message}`,
        );
      } else {
        this.failed = true;
        this.lifecycle.fail('UDP frame processing failed');
      }
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    this.socket = undefined;

    if (socket) {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  }
}
