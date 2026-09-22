import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import type { Noble } from '@stoprocent/noble';
import debounce from 'lodash/debounce';

import { TrackerConfig } from '../config/config.service';
import { FhnParserService, isFhnUuid } from '../fhn/fhn-parser.service';
import { TagMatcherService } from '../fhn/tag-matcher.service';
import { LifecycleService } from '../lifecycle.service';
import { MetricsService } from '../metrics/metrics.service';
import { monotonicTime, wallTime } from '../util/time';
import { Advertisement } from './advertisement.types';

const REPORT_INTERVAL_MS = 180_000;

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

        if (signal?.aborted) {
          cancel();
        } else {
          signal?.addEventListener('abort', cancel, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);

    if (cancel) {
      signal?.removeEventListener('abort', cancel);
    }
  }
}

@Injectable()
export class BluetoothService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private noble?: Noble;
  private task?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly logger = new Logger(BluetoothService.name);
  private readonly scheduleReport = debounce(() => this.report(), REPORT_INTERVAL_MS, {
    maxWait: REPORT_INTERVAL_MS,
  });

  private adapterAvailable: boolean | undefined;
  private scannerActive = false;
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
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log(`Bluetooth adapter hci${this.config.settings.adapter} selected`);
    this.task = this.run().catch(() => {
      this.setScannerUp(false);

      if (!this.abort.signal.aborted) {
        this.lifecycle.fail('BLE scanner failed; check adapter and permissions');
      }
    });
  }

  private setScannerUp(up: boolean): void {
    this.scannerActive = up;
    this.metrics?.setBluetoothScannerUp(up);
  }

  private setAdapterState(state: string): void {
    const available = state === 'poweredOn';

    if (this.adapterAvailable !== available) {
      this.logger.log(
        `Bluetooth adapter hci${this.config.settings.adapter} became ${available ? 'available' : 'unavailable'}`,
      );
    }

    this.adapterAvailable = available;
    this.metrics?.setBluetoothAdapterUp(available);

    if (!available) {
      this.scanFailed = true;
      this.setScannerUp(false);
    }
  }

  accept(advertisement: Advertisement): void {
    if (this.abort.signal.aborted || this.fatalCallback) {
      return;
    }

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

      const tag = this.matcher.observe(eid, advertisement.rssi, wallTime());

      if (tag === null) {
        this.counts.unmatched++;

        return;
      }

      if (this.config.value.debugScan) {
        this.logger.log(`Tag matched: ${tag} RSSI=${advertisement.rssi} dBm`);
      }

      this.counts.matched++;
      this.latestRssi.set(tag, advertisement.rssi);
    } catch {
      this.fatalCallback = true;
      this.setScannerUp(false);
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

      if (signal.aborted) {
        cancel();
      } else {
        signal.addEventListener('abort', cancel, { once: true });
      }
    });
  }

  private async run(): Promise<void> {
    this.noble = this.factory(this.config.settings.adapter);
    const noble = this.noble;

    noble.removeAllListeners('warning');
    noble.on('warning', () => {
      if (!this.scanFailed) {
        this.logger.warn('BLE backend warning');
      }

      this.scanFailed = true;
      this.setScannerUp(false);
    });

    noble.on('error', () => {
      this.scanFailed = true;
      this.setScannerUp(false);
    });

    noble.on('discover', (advertisement: Advertisement) => this.accept(advertisement));

    noble.on('stateChange', (state: string) => this.setAdapterState(state));
    // Reading state initializes bindings; observe the initial state as well as events.
    this.setAdapterState(noble.state);
    // noble exits immediately if its SIGINT listener is last; keep Nest in charge.
    process.on('SIGINT', this.sigintGuard);
    noble.on('scanStop', () => {
      if (!this.stoppingScan && !this.abort.signal.aborted) {
        if (this.scannerActive || !this.scanFailed) {
          this.logger.warn('BLE scanner stopped unexpectedly');
        }

        this.scanFailed = true;
      }

      this.setScannerUp(false);
    });
    let failures = 0;
    let recovering = false;

    while (!this.abort.signal.aborted) {
      const started = monotonicTime();
      let startAttempted = false;
      let cleanupFailed = false;
      this.scanFailed = false;

      try {
        while (noble.state !== 'poweredOn') {
          if (monotonicTime() - started >= 30) {
            throw new Error('Adapter unavailable');
          }

          await this.pause(1000);
        }

        this.scanFailed = false;
        startAttempted = true;

        if (recovering) {
          this.metrics?.recordBluetoothScannerRestart();
          this.logger.log('Restarting BLE scanner');
        }

        // No advertised UUID filter: FEAA may appear only in service data.
        await bounded(noble.startScanningAsync([], true), 30_000, this.abort.signal);

        // A state/stop/error event may arrive while the start promise is pending.
        if (
          this.scanFailed ||
          !this.adapterAvailable ||
          this.abort.signal.aborted ||
          this.fatalCallback
        ) {
          throw new Error('Scanner failed during startup');
        }

        this.setScannerUp(true);
        this.logger.log('BLE scanner started');

        if (recovering) {
          this.logger.log('BLE scanner recovered');
          recovering = false;
        }

        while (monotonicTime() - started < this.config.settings.scannerCycleSeconds) {
          if (this.scanFailed || this.fatalCallback) {
            throw new Error('Scanner stopped unexpectedly');
          }

          this.scheduleReport();

          await this.pause(1000);
        }
      } catch {
        this.setScannerUp(false);

        if (!this.abort.signal.aborted) {
          recovering = true;
          failures = monotonicTime() - started > 60 ? 1 : failures + 1;
          this.logger.error(`BLE scanner error, attempt ${failures}`);
          this.scanFailed = true;
        }
      } finally {
        this.setScannerUp(false);
        this.scheduleReport.cancel();

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
      if (cleanupFailed) {
        throw new Error('BLE scanner cleanup failed');
      }

      if (this.abort.signal.aborted) {
        return;
      }

      if (this.scanFailed) {
        recovering = true;
        failures = Math.max(1, failures);

        if (failures >= 5) {
          throw new Error('BLE recovery exhausted');
        }

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
    this.setScannerUp(false);
    this.abort.abort();
    await this.task;

    try {
      this.noble?.stop();
    } finally {
      process.removeListener('SIGINT', this.sigintGuard);
    }
  }
}
