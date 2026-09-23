import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';

import { Advertisement } from '../bluetooth/advertisement.types';
import { bounded, createNoble } from '../bluetooth/bluetooth.service';
import { TrackerConfig } from '../config/config.service';
import { loadConfiguration } from '../config/configuration';
import { EidService } from '../fhn/eid.service';
import { FhnParserService } from '../fhn/fhn-parser.service';
import { TagMatcherService } from '../fhn/tag-matcher.service';

async function main(): Promise<void> {
  process.umask(0o077);

  const configuration = loadConfiguration(process.env, process.argv.slice(2));
  const config = new TrackerConfig(new ConfigService({ tracker: configuration }));
  const parser = new FhnParserService();
  const matcher = new TagMatcherService(config, new EidService());
  const noble = createNoble(configuration.settings.adapter);

  let scanAttempted = false;
  let finish!: (result?: Error) => void;
  const done = new Promise<Error | undefined>((resolve) => {
    finish = resolve;
  });
  const stop = () => finish();

  noble.removeAllListeners('warning');
  noble.on('discover', (peripheral: Advertisement) => {
    const eid = parser.parse(peripheral.advertisement.serviceData || []);

    if (!eid) {
      return;
    }

    const tag = matcher.match(eid, Date.now() / 1000);

    if (tag !== null) {
      console.log(`${tag} RSSI=${peripheral.rssi} dBm`);
    }
  });
  noble.on('error', () => finish(new Error('Bluetooth scanner error')));
  noble.on('scanStop', () => {
    if (scanAttempted) {
      finish(new Error('Bluetooth scan stopped unexpectedly'));
    }
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    if (noble.state !== 'poweredOn') {
      const ready = new Promise<void>((resolve) => {
        const onStateChange = (state: string) => {
          if (state === 'poweredOn') {
            noble.removeListener('stateChange', onStateChange);
            resolve();
          }
        };

        noble.on('stateChange', onStateChange);
        onStateChange(noble.state);
      });
      await bounded(ready, 30_000);
    }

    // FEAA can appear only in service data, so scan without a UUID filter.
    scanAttempted = true;
    await bounded(noble.startScanningAsync([], true), 30_000);
    const result = await done;

    if (result) {
      throw result;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);

    try {
      if (scanAttempted) {
        await bounded(noble.stopScanningAsync(), 15_000);
      }
    } finally {
      noble.stop();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Debug scanner failed');
  process.exitCode = 1;
});
