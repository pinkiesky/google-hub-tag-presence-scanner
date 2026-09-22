import { EventEmitter } from 'node:events';

import { Logger } from '@nestjs/common';
import type { Noble } from '@stoprocent/noble';

import { BluetoothService } from '../src/bluetooth/bluetooth.service';
import { EidService } from '../src/fhn/eid.service';
import { FhnParserService } from '../src/fhn/fhn-parser.service';
import { TagMatcherService } from '../src/fhn/tag-matcher.service';
import { LifecycleService } from '../src/lifecycle.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { TagObservationService } from '../src/observations/tag-observation.service';
import { PresenceService } from '../src/presence/presence.service';
import { config, manager, tags } from './helpers';

class FakeNoble extends EventEmitter {
  state = 'poweredOn';
  startScanningAsync = jest.fn(async () => {});
  stopScanningAsync = jest.fn(async () => {
    this.emit('scanStop');
  });

  stop = jest.fn();
}
let scanner: BluetoothService, noble: FakeNoble, presence: PresenceService;
let fail: jest.SpyInstance;

function setup(cycle = 300) {
  const cfg = config({ scannerCycleSeconds: cycle });
  noble = new FakeNoble();
  presence = manager();
  const lifecycle = new LifecycleService();
  fail = jest.spyOn(lifecycle, 'fail').mockImplementation(() => {});
  const factory = jest.fn(() => noble as unknown as Noble);
  scanner = new BluetoothService(
    cfg,
    new FhnParserService(),
    new TagMatcherService(
      cfg,
      new EidService(),
      new TagObservationService(presence, new MetricsService(presence)),
    ),
    lifecycle,
    factory,
  );

  return factory;
}

beforeEach(() => jest.useFakeTimers({ now: (10000 + 2048) * 1000 }));
afterEach(async () => {
  await scanner?.beforeApplicationShutdown();
  presence?.store.onApplicationShutdown();
  jest.useRealTimers();
});
test('one scanner, unfiltered service data and both real matching paths', async () => {
  const factory = setup();
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith(0);
  expect(noble.startScanningAsync).toHaveBeenCalledWith([], true);

  for (const tag of tags) {
    const eid = new EidService().calculate(tag.eik, 2048);
    noble.emit('discover', {
      rssi: -62,
      advertisement: {
        serviceUuids: [],
        serviceData: [{ uuid: 'feaa', data: Buffer.concat([Buffer.from([0x40]), eid]) }],
      },
    });
    expect(presence.getAllStatuses().find((status) => status.id === tag.id)!.signalDbm).toBe(-62);
  }

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
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
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
test('database callback error terminates service instead of disappearing in emitter', async () => {
  setup();
  jest.spyOn(presence, 'observe').mockImplementation(() => {
    throw new Error('disk full');
  });
  scanner.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
  const eid = new EidService().calculate(tags[0].eik, 2048);
  noble.emit('discover', {
    rssi: -61,
    advertisement: {
      serviceData: [{ uuid: 'feaa', data: Buffer.concat([Buffer.from([0x40]), eid]) }],
    },
  });
  expect(fail).toHaveBeenCalledWith('BLE observation processing failed');
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
