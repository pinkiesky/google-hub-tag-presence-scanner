import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';

import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';

import { TrackerConfig } from '../config/config.service';
import { LifecycleService } from '../lifecycle.service';
import { CattagFrameError, parseCattagFrame } from './cattag-frame';

const PREVIEW_BYTES = 64;

@Injectable()
export class UdpService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(UdpService.name);
  private socket?: Socket;
  private closing = false;

  constructor(
    private readonly config: TrackerConfig,
    private readonly lifecycle: LifecycleService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const socket = createSocket('udp4');
    this.socket = socket;
    socket.on('message', (data: Buffer, peer: RemoteInfo) => {
      try {
        const frame = parseCattagFrame(data);
        const preview = frame.serviceData.subarray(0, PREVIEW_BYTES).toString('hex');
        const suffix = frame.serviceData.length > PREVIEW_BYTES ? '…' : '';
        this.logger.log(
          `CatTag UDP from ${peer.address}:${peer.port}: satelliteId=${frame.satelliteId} bootId=0x${frame.bootId.toString(16).padStart(16, '0')} sequence=${frame.sequence} uuid=feaa address=${frame.address.toString('hex')} dataLength=${frame.serviceData.length} serviceData=${preview}${suffix}`,
        );
      } catch (error) {
        if (error instanceof CattagFrameError) {
          this.logger.warn(
            `Invalid CatTag UDP from ${peer.address}:${peer.port}: ${data.length} bytes, ${error.message}`,
          );
        } else {
          this.lifecycle.fail('UDP frame processing failed');
        }
      }
    });

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

  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    this.socket = undefined;

    if (socket) {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  }
}
