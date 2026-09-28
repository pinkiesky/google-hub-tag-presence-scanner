import { EventEmitter } from 'node:events';

import type { Noble } from '@stoprocent/noble';

import { BluetoothService } from '../src/bluetooth.service';
import { Observation } from '../src/protocol';

class FakeNoble extends EventEmitter {
  state = 'poweredOn';
  startScanningAsync = jest.fn(async () => {});
  stopScanningAsync = jest.fn(async () => {
    this.emit('scanStop');
  });

  stop = jest.fn();
}
let scanner: BluetoothService, noble: FakeNoble;
let fail: jest.Mock;
let forward: jest.Mock<void, [Observation]>;

function setup(cycle = 300, adapter = 0) {
  noble = new FakeNoble();
  fail = jest.fn();
  forward = jest.fn();
  const factory = jest.fn(() => noble as unknown as Noble);
  scanner = new BluetoothService(
    { motherUrl: 'http://localhost', satelliteId: 'pi-1', adapter, scannerCycleSeconds: cycle },
    forward,
    fail,
    factory,
  );

  return factory;
}

beforeEach(() => jest.useFakeTimers({ now: (10000 + 2048) * 1000 }));
afterEach(async () => {
  await scanner?.beforeApplicationShutdown();
  jest.useRealTimers();
});
test('one FEAA scanner forwards exact raw bytes without identifying tags', async () => {
  const factory = setup();
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith(0);
  expect(noble.startScanningAsync).toHaveBeenCalledWith(['feaa'], true);
  noble.emit('discover', {
    rssi: -62,
    advertisement: {
      serviceData: [
        { uuid: '1234', data: Buffer.from('abcd', 'hex') },
        { uuid: 'FEAA', data: Buffer.from('400001feff', 'hex') },
      ],
    },
  });
  expect(forward).toHaveBeenCalledTimes(1);
  expect(forward).toHaveBeenCalledWith({
    satelliteId: 'pi-1',
    serviceUuid: 'feaa',
    serviceDataHex: '400001feff',
    rssi: -62,
  });
  await scanner.beforeApplicationShutdown();
  expect(noble.stopScanningAsync).toHaveBeenCalledTimes(1);
  expect(noble.stop).toHaveBeenCalled();
});
test('transient errors back off then resume', async () => {
  setup();
  noble.startScanningAsync.mockRejectedValueOnce(new Error()).mockRejectedValueOnce(new Error());
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(15000);
  expect(noble.startScanningAsync).toHaveBeenCalledTimes(3);
  expect(fail).not.toHaveBeenCalled();
});
test('reports periodically during scanning and cancels pending reports on shutdown', async () => {
  setup(600);
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const summaries = () =>
    log.mock.calls.filter(([message]) => String(message).startsWith('BLE scan summary:'));

  try {
    scanner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(179_000);
    expect(summaries()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1000);
    expect(summaries()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(180_000);
    expect(summaries()).toHaveLength(2);
    await scanner.beforeApplicationShutdown();
    expect(summaries()).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(180_000);
    expect(summaries()).toHaveLength(3);
  } finally {
    log.mockRestore();
  }
});
test('five short failures exhaust recovery', async () => {
  setup();
  noble.startScanningAsync.mockRejectedValue(new Error());
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(75000);
  expect(noble.startScanningAsync).toHaveBeenCalledTimes(5);
  expect(fail).toHaveBeenCalled();
});
test('failed cleanup is fatal with no second scan', async () => {
  setup();
  noble.startScanningAsync.mockRejectedValue(new Error());
  noble.stopScanningAsync.mockRejectedValue(new Error());
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(10000);
  expect(noble.startScanningAsync).toHaveBeenCalledTimes(1);
  expect(fail).toHaveBeenCalled();
});
test('scheduled and unexpected stop recover without overlapping scans', async () => {
  setup(5);
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(5000);
  expect(noble.startScanningAsync).toHaveBeenCalledTimes(2);
  noble.emit('scanStop');
  await jest.advanceTimersByTimeAsync(6000);
  expect(noble.startScanningAsync).toHaveBeenCalledTimes(3);
});
test('shutdown aborts a hung scan start without waiting the full start timeout', async () => {
  setup();
  noble.startScanningAsync.mockImplementation(() => new Promise(() => {}));
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
  await scanner.beforeApplicationShutdown();
  expect(noble.stopScanningAsync).toHaveBeenCalledTimes(1);
  expect(noble.stop).toHaveBeenCalled();
});

test('successful scan shuts down cleanly', async () => {
  setup();
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
  await scanner.beforeApplicationShutdown();
  expect(noble.stop).toHaveBeenCalled();
});

test.each(['poweredOff', 'unauthorized', 'unsupported', 'unknown', 'resetting'])(
  'adapter state %s triggers scanner recovery',
  async (state) => {
    setup(300, 1);
    scanner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    noble.state = state;
    noble.emit('stateChange', state);
    noble.state = 'poweredOn';
    noble.emit('stateChange', 'poweredOn');
    await jest.advanceTimersByTimeAsync(6000);
    expect(noble.stopScanningAsync).toHaveBeenCalledTimes(1);
    expect(noble.startScanningAsync).toHaveBeenCalledTimes(2);
    expect(fail).not.toHaveBeenCalled();
  },
);

test.each(['scanStop', 'error', 'warning'])('%s triggers scanner recovery', async (event) => {
  setup();
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
  noble.emit(event);
  await jest.advanceTimersByTimeAsync(6000);
  expect(noble.stopScanningAsync).toHaveBeenCalledTimes(1);
  expect(noble.startScanningAsync).toHaveBeenCalledTimes(2);
  expect(fail).not.toHaveBeenCalled();
});

test('failed starts count only actual recovery attempts and scheduled refreshes do not count', async () => {
  setup(5);
  noble.startScanningAsync.mockRejectedValueOnce(new Error());
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
  await jest.advanceTimersByTimeAsync(5000);
  await jest.advanceTimersByTimeAsync(5000);
  expect(noble.startScanningAsync).toHaveBeenCalledTimes(3);
});

test('pending startup cannot report healthy after adapter failure', async () => {
  setup();
  let finish!: () => void;
  noble.startScanningAsync.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
  noble.state = 'poweredOff';
  noble.emit('stateChange', 'poweredOff');
  finish();
  await jest.advanceTimersByTimeAsync(0);
  expect(noble.stopScanningAsync).toHaveBeenCalledTimes(1);
  expect(console.log).not.toHaveBeenCalledWith('BLE scanner started');
});

test('unavailable adapter at startup stays down without a scan attempt', async () => {
  setup();
  noble.state = 'poweredOff';
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(1000);
  expect(noble.startScanningAsync).not.toHaveBeenCalled();
  noble.state = 'poweredOn';
  noble.emit('stateChange', 'poweredOn');
  await jest.advanceTimersByTimeAsync(1000);
  expect(noble.startScanningAsync).toHaveBeenCalledTimes(1);
});

test('repeated state events log only transitions and recovery logs once', async () => {
  setup();
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  try {
    scanner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    noble.emit('stateChange', 'poweredOn');
    noble.emit('stateChange', 'poweredOn');
    expect(
      log.mock.calls.filter(([message]) => message === 'Bluetooth adapter hci0 became available'),
    ).toHaveLength(1);
    noble.emit('scanStop');
    noble.emit('scanStop');
    expect(
      warn.mock.calls.filter(([message]) => message === 'BLE scanner stopped unexpectedly'),
    ).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(6000);
    expect(log.mock.calls.filter(([message]) => message === 'Restarting BLE scanner')).toHaveLength(
      1,
    );
    expect(log.mock.calls.filter(([message]) => message === 'BLE scanner recovered')).toHaveLength(
      1,
    );
    noble.state = 'poweredOff';
    noble.emit('stateChange', 'poweredOff');
    noble.emit('stateChange', 'poweredOff');
    expect(
      log.mock.calls.filter(([message]) => message === 'Bluetooth adapter hci0 became unavailable'),
    ).toHaveLength(1);
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
});
