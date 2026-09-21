import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import type { Noble } from '@stoprocent/noble';
import { TrackerConfig } from '../config/config.service';
import { FhnParserService, isFhnUuid } from '../fhn/fhn-parser.service';
import { TagMatcherService } from '../fhn/tag-matcher.service';
import { PresenceService, monotonicTime, wallTime } from '../presence/presence.service';
import { LifecycleService } from '../lifecycle.service';
import { Advertisement } from './advertisement.types';
export const NOBLE_FACTORY = Symbol('NOBLE_FACTORY');
export type NobleFactory = (adapter: number) => Noble;
export function createNoble(adapter: number): Noble {
  process.env.NOBLE_REPORT_ALL_HCI_EVENTS = '1';
  // Lazy import: no native Bluetooth initialization in unit tests or DI construction.
  // The library's default instance is lazy; only this configured instance is started.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withBindings } = require('@stoprocent/noble') as typeof import('@stoprocent/noble');
  return withBindings('hci', { hciDriver: 'native', deviceId: adapter, userChannel: false });
}
export async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('BLE operation timed out')), milliseconds);
        cancel = () => reject(new Error('BLE operation canceled'));
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}
@Injectable()
export class BluetoothService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private noble?: Noble;
  private task?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly logger = new Logger(BluetoothService.name);
  private scanFailed = false;
  private stoppingScan = false;
  private fatalCallback = false;
  private readonly sigintGuard = () => {
    /* Nest owns signal shutdown, not noble. */
  };
  private counts = { received: 0, other: 0, invalid: 0, unmatched: 0, matched: 0 };
  private readonly latestRssi = new Map<string, number>();
  constructor(
    private readonly config: TrackerConfig,
    private readonly parser: FhnParserService,
    private readonly matcher: TagMatcherService,
    private readonly lifecycle: LifecycleService,
    @Inject(NOBLE_FACTORY) private readonly factory: NobleFactory,
    @Optional() private readonly presence?: PresenceService,
  ) {}
  onApplicationBootstrap(): void {
    this.logger.log(`Bluetooth adapter hci${this.config.settings.adapter} selected`);
    this.task = this.run().catch(() => {
      if (!this.abort.signal.aborted)
        this.lifecycle.fail('BLE scanner failed; check adapter and permissions');
    });
  }
  accept(advertisement: Advertisement): void {
    if (this.abort.signal.aborted || this.fatalCallback) return;
    try {
      this.counts.received++;
      const data = advertisement.advertisement.serviceData;
      if (!data.some((item) => isFhnUuid(item.uuid))) {
        this.counts.other++;
        return;
      }
      const eid = this.parser.parse(data);
      if (!eid) {
        this.counts.invalid++;
        return;
      }
      const tag = this.matcher.match(eid);
      if (tag === null) {
        this.counts.unmatched++;
        return;
      }
      if (this.config.value.debugScan)
        this.logger.log(`Tag matched: ${tag} RSSI=${advertisement.rssi} dBm`);
      else this.presence!.observe(tag, wallTime(), advertisement.rssi);
      this.counts.matched++;
      this.latestRssi.set(tag, advertisement.rssi);
    } catch {
      this.fatalCallback = true;
      this.lifecycle.fail('BLE observation processing failed');
    }
  }
  private report(): void {
    const counts = Object.entries(this.counts)
      .map(([name, value]) => `${name}=${value}`)
      .join(' ');
    const tags =
      [...this.latestRssi]
        .sort()
        .map(([id, rssi]) => `${id}: ${rssi} dBm`)
        .join(', ') || 'none';
    this.logger.log(
      `BLE scan summary: adapter=hci${this.config.settings.adapter} ${counts} tags=${tags}`,
    );
    this.counts = { received: 0, other: 0, invalid: 0, unmatched: 0, matched: 0 };
    this.latestRssi.clear();
  }
  private async pause(milliseconds: number): Promise<void> {
    const signal = this.abort.signal;
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        reject(new Error('Scanner shutdown'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, milliseconds);
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
  }
  private async run(): Promise<void> {
    this.noble = this.factory(this.config.settings.adapter);
    const noble = this.noble;
    noble.removeAllListeners('warning');
    noble.on('warning', () => {
      this.scanFailed = true;
      this.logger.warn('BLE backend warning');
    });
    noble.on('error', () => {
      this.scanFailed = true;
    });
    noble.on('discover', (advertisement: Advertisement) => this.accept(advertisement));
    // Read state first: initializes bindings synchronously, avoiding nextTick throws.
    void noble.state;
    // noble exits immediately if its SIGINT listener is last; keep Nest in charge.
    process.on('SIGINT', this.sigintGuard);
    noble.on('stateChange', (state: string) => {
      if (state !== 'poweredOn') this.scanFailed = true;
    });
    noble.on('scanStop', () => {
      if (!this.stoppingScan) this.scanFailed = true;
    });
    let failures = 0;
    while (!this.abort.signal.aborted) {
      const started = monotonicTime();
      let startAttempted = false;
      let cleanupFailed = false;
      this.scanFailed = false;
      try {
        this.matcher.refresh(wallTime());
        while (noble.state !== 'poweredOn') {
          if (monotonicTime() - started >= 30) throw new Error('Adapter unavailable');
          await this.pause(1000);
        }
        this.scanFailed = false;
        startAttempted = true;
        // No advertised UUID filter: FEAA may appear only in service data.
        await bounded(noble.startScanningAsync([], true), 30_000, this.abort.signal);
        this.logger.log('BLE scanner started');
        let nextReport = monotonicTime() + 30;
        while (monotonicTime() - started < this.config.settings.scannerCycleSeconds) {
          if (this.scanFailed) throw new Error('Scanner stopped unexpectedly');
          this.matcher.refresh(wallTime());
          if (monotonicTime() >= nextReport) {
            this.report();
            nextReport = monotonicTime() + 30;
          }
          await this.pause(1000);
        }
      } catch {
        if (!this.abort.signal.aborted) {
          failures = monotonicTime() - started > 60 ? 1 : failures + 1;
          this.logger.error(`BLE scanner error, attempt ${failures}`);
          this.scanFailed = true;
        }
      } finally {
        if (startAttempted) {
          this.stoppingScan = true;
          try {
            await bounded(noble.stopScanningAsync(), 15_000);
          } catch {
            cleanupFailed = true;
          } finally {
            this.stoppingScan = false;
            this.report();
          }
        }
      }
      // Never restart when ownership/cleanup is uncertain.
      if (cleanupFailed) throw new Error('BLE scanner cleanup failed');
      if (this.abort.signal.aborted) return;
      if (this.scanFailed) {
        if (failures >= 5) throw new Error('BLE recovery exhausted');
        const delay = Math.min(60, 5 * 2 ** (failures - 1));
        this.logger.warn(`Retrying BLE scanner in ${delay} seconds`);
        await this.pause(delay * 1000);
      } else {
        failures = 0;
        this.logger.log('Refreshing BLE discovery after scheduled scan cycle');
      }
    }
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.task;
    try {
      this.noble?.stop();
    } finally {
      process.removeListener('SIGINT', this.sigintGuard);
    }
  }
}
