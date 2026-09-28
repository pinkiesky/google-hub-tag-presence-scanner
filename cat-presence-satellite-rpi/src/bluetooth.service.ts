import type { Noble } from '@stoprocent/noble';
import debounce from 'lodash/debounce';

import { Advertisement } from './advertisement.types';
import { SatelliteConfig } from './config';
import { isFeaa, Observation } from './protocol';
import { monotonicTime } from './util/time';

const REPORT_INTERVAL_MS = 180_000;

export type NobleFactory = (adapter: number) => Noble;

export function createNoble(adapter: number): Noble {
  process.env.NOBLE_REPORT_ALL_HCI_EVENTS = '1';
  // Lazy import: no native Bluetooth initialization in unit tests or construction.
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

export class BluetoothService {
  private noble?: Noble;
  private task?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly logger = console;
  private readonly scheduleReport = debounce(() => this.report(), REPORT_INTERVAL_MS, {
    maxWait: REPORT_INTERVAL_MS,
  });

  private adapterAvailable: boolean | undefined;
  private scannerActive = false;
  private scanFailed = false;
  private stoppingScan = false;
  private fatalCallback = false;
  private readonly sigintGuard = () => {
    /* The application owns signal shutdown, not noble. */
  };

  private counts = { received: 0, forwarded: 0 };
  constructor(
    private readonly config: SatelliteConfig,
    private readonly forward: (observation: Observation) => void,
    private readonly fail: (message: string) => void,
    private readonly factory: NobleFactory = createNoble,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log(`Bluetooth adapter hci${this.config.adapter} selected`);
    this.task = this.run().catch(() => {
      this.setScannerUp(false);

      if (!this.abort.signal.aborted) {
        this.fail('BLE scanner failed; check adapter and permissions');
      }
    });
  }

  private setScannerUp(up: boolean): void {
    this.scannerActive = up;
  }

  private setAdapterState(state: string): void {
    const available = state === 'poweredOn';

    if (this.adapterAvailable !== available) {
      this.logger.log(
        `Bluetooth adapter hci${this.config.adapter} became ${available ? 'available' : 'unavailable'}`,
      );
    }

    this.adapterAvailable = available;

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

      for (const item of advertisement.advertisement.serviceData ?? []) {
        if (
          !isFeaa(item.uuid) ||
          !item.data.length ||
          item.data.length > 255 ||
          !Number.isFinite(advertisement.rssi)
        ) {
          continue;
        }

        this.forward({
          satelliteId: this.config.satelliteId,
          serviceUuid: 'feaa',
          serviceDataHex: item.data.toString('hex'),
          rssi: advertisement.rssi,
        });
        this.counts.forwarded++;
      }
    } catch {
      this.fatalCallback = true;
      this.setScannerUp(false);
      this.fail('BLE observation processing failed');
    }
  }

  private report(): void {
    const counts = Object.entries(this.counts)
      .map(([name, value]) => `${name}=${value}`)
      .join(' ');
    this.logger.log(`BLE scan summary: adapter=hci${this.config.adapter} ${counts}`);
    this.counts = { received: 0, forwarded: 0 };
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
    this.noble = this.factory(this.config.adapter);
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
    // noble exits immediately if its SIGINT listener is last; keep the application in charge.
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
          this.logger.log('Restarting BLE scanner');
        }

        await bounded(noble.startScanningAsync(['feaa'], true), 30_000, this.abort.signal);

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

        while (monotonicTime() - started < this.config.scannerCycleSeconds) {
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
