import { BluetoothService } from './bluetooth.service';
import { loadConfig } from './config';
import { Forwarder } from './forwarder';

export async function run(diagnostic = false): Promise<void> {
  const config = loadConfig();
  const forwarder = new Forwarder(config.motherUrl);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const scanner = new BluetoothService(
    config,
    (observation) => {
      if (diagnostic) {
        console.log(
          `BLE reception: adapter=hci${config.adapter} RSSI=${observation.rssi} dBm bytes=${observation.serviceDataHex.length / 2}`,
        );
      } else {
        forwarder.enqueue(observation);
      }
    },
    (message) => {
      console.error(message);
      process.exitCode = 1;
      finish();
    },
  );
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);

  try {
    if (!diagnostic) {
      forwarder.start();
    }

    scanner.onApplicationBootstrap();
    await done;
  } finally {
    await Promise.all([scanner.beforeApplicationShutdown(), forwarder.stop()]);
    process.removeListener('SIGINT', finish);
    process.removeListener('SIGTERM', finish);
  }
}
