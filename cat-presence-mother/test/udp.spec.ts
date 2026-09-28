import { createSocket, type Socket } from 'node:dgram';
import { once } from 'node:events';

import { Global, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { TrackerConfig } from '../src/config/config.service';
import { EidService } from '../src/fhn/eid.service';
import { FhnParserService } from '../src/fhn/fhn-parser.service';
import { TagMatcherService } from '../src/fhn/tag-matcher.service';
import { LifecycleService } from '../src/lifecycle.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { PresenceService } from '../src/presence/presence.service';
import { CATTAG_HEADER_LENGTH } from '../src/udp/cattag-frame';
import { UdpModule } from '../src/udp/udp.module';
import { UdpService } from '../src/udp/udp.service';
import { config, manager, tags } from './helpers';

const presences: PresenceService[] = [];
afterEach(() => {
  for (const presence of presences.splice(0)) {
    presence.store.onApplicationShutdown();
  }
});

function createService(port = 0) {
  const cfg = config({ udpPort: port });
  const matcher = new TagMatcherService(cfg, new EidService(), { observe: jest.fn() });
  const presence = manager();
  presences.push(presence);
  const metrics = new MetricsService(presence);

  return {
    service: new UdpService(cfg, new LifecycleService(), new FhnParserService(), matcher, metrics),
    matcher,
    metrics,
  };
}

function packet(
  sequence: bigint,
  satelliteName = 'kitchen',
  bootId = 1n,
  eid: Buffer = Buffer.alloc(20, 0xab),
  rssi = -63,
): Buffer {
  const data = Buffer.concat([Buffer.from([0x40]), eid]);
  const bytes = Buffer.alloc(CATTAG_HEADER_LENGTH + data.length);
  bytes[0] = 0xca;
  bytes[1] = 7;
  bytes.writeBigUInt64BE(bootId, 18);
  bytes.writeBigUInt64BE(sequence, 26);
  bytes.writeUInt16BE(0xfeaa, 34);
  bytes.writeInt8(rssi, 42);
  bytes[43] = data.length;
  bytes.write(satelliteName, 2, 'utf8');
  data.copy(bytes, CATTAG_HEADER_LENGTH);

  return bytes;
}

test('UDP listener logs parsed frame fields and bounded service data, then closes', async () => {
  const messages: string[] = [];
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
    messages.push(String(message));
  });
  const { service } = createService();
  const client = createSocket('udp4');

  try {
    await service.onApplicationBootstrap();
    const listener = Reflect.get(service, 'socket') as Socket;
    const port = listener.address().port;
    const payload = Buffer.alloc(CATTAG_HEADER_LENGTH + 65, 0xab);
    payload[0] = 0xca;
    payload[1] = 7;
    payload.writeBigUInt64BE(0x0123456789abcdefn, 18);
    payload.writeBigUInt64BE(0n, 26);
    payload.writeUInt16BE(0xfeaa, 34);
    Buffer.from([1, 2, 3, 4, 5, 6]).copy(payload, 36);
    payload.writeInt8(-63, 42);
    payload[43] = 65;
    payload.fill(0, 2, 18);
    payload.write('kitchen', 2, 'utf8');
    const received = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('UDP packet not received')), 1000);
      const original = log.getMockImplementation();
      log.mockImplementation((message: unknown) => {
        original?.(message);

        if (String(message).startsWith('CatTag UDP from ')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      client.send(payload, port, '127.0.0.1', (error) => (error ? reject(error) : resolve()));
    });
    await received;
    expect(messages.at(-1)).toMatch(/^CatTag UDP from 127\.0\.0\.1:\d+:/);
    expect(messages.at(-1)).toContain(
      'satelliteName="kitchen" bootId=0x0123456789abcdef sequence=0 uuid=feaa address=010203040506 rssi=-63 dataLength=65',
    );
    expect(messages.at(-1)).toContain(`serviceData=${'ab'.repeat(64)}…`);
  } finally {
    client.close();
    await service.beforeApplicationShutdown();
    log.mockRestore();
  }
});

test('UDP listener rejects a port that is already in use', async () => {
  const occupied = createSocket('udp4');
  await new Promise<void>((resolve) => occupied.bind(0, '127.0.0.1', resolve));
  const { service } = createService(occupied.address().port);

  try {
    await expect(service.onApplicationBootstrap()).rejects.toThrow('UDP listener failed to bind');
  } finally {
    occupied.close();
    await service.beforeApplicationShutdown();
  }
});

test('sequences increase independently for each satellite and boot, regardless of peer address', async () => {
  const { service, matcher, metrics } = createService();
  const observe = jest.spyOn(matcher, 'observe').mockReturnValue('a');
  const peer = { address: '127.0.0.1', port: 12345 };
  service.accept(packet(0n), peer);
  service.accept(packet(0n), { address: '127.0.0.2', port: 54321 });
  service.accept(packet(3n), peer);
  service.accept(packet(2n), peer);
  service.accept(packet(3n), peer);
  service.accept(packet(0n, 'hall'), peer);
  service.accept(packet(0n, 'kitchen', 2n), peer);
  service.accept(packet(3n, 'kitchen', 1n), peer);
  service.accept(packet(9007199254740992n), peer);
  service.accept(packet(9007199254740993n), peer);
  expect(observe.mock.calls.map((call) => call[3])).toEqual([
    'satellite:kitchen',
    'satellite:kitchen',
    'satellite:hall',
    'satellite:kitchen',
    'satellite:kitchen',
    'satellite:kitchen',
  ]);
  expect(observe.mock.calls.every((call) => call[1] === -63)).toBe(true);
  const text = await metrics.getMetrics();

  for (const line of [
    '# TYPE cat_udp_packets_received_total counter',
    '# TYPE cat_udp_packets_lost_total counter',
    '# TYPE cat_udp_packets_stale_total counter',
    '# TYPE cat_udp_packets_invalid_total counter',
    'cat_udp_packets_received_total{satellite="kitchen"} 5',
    'cat_udp_packets_received_total{satellite="hall"} 1',
    // Boot 1: 0 → 3 skips 1 and 2; 3 → 2^53 skips 2^53 - 4; 2^53 → 2^53 + 1 skips none.
    'cat_udp_packets_lost_total{satellite="kitchen"} 9007199254740990',
    'cat_udp_packets_lost_total{satellite="hall"} 0',
    'cat_udp_packets_stale_total{satellite="kitchen"} 4',
    'cat_udp_packets_invalid_total 0',
  ]) {
    expect(text).toContain(line);
  }

  expect(text).not.toContain('cat_udp_packets_stale_total{satellite="hall"}');
});

test('drop rate counts gaps against accepted frames; first frame of a boot has no baseline', async () => {
  const { service, matcher, metrics } = createService();
  jest.spyOn(matcher, 'observe').mockReturnValue(null);
  const peer = { address: '127.0.0.1', port: 12345 };

  for (const sequence of [5n, 6n, 9n, 10n, 7n, 14n]) {
    service.accept(packet(sequence), peer);
  }

  service.accept(packet(100n, 'kitchen', 2n), peer);
  const text = await metrics.getMetrics();
  expect(text).toContain('cat_udp_packets_received_total{satellite="kitchen"} 6');
  expect(text).toContain('cat_udp_packets_lost_total{satellite="kitchen"} 5');
  expect(text).toContain('cat_udp_packets_stale_total{satellite="kitchen"} 1');
});

test('invalid frames and invalid service data do not reach matching or advance sequence', async () => {
  const { service, matcher, metrics } = createService();
  const observe = jest.spyOn(matcher, 'observe').mockReturnValue(null);
  const peer = { address: '127.0.0.1', port: 12345 };
  service.accept(packet(100n).subarray(0, -1), peer);
  service.accept(packet(100n, 'kitchen', 1n, Buffer.alloc(3)), peer);
  expect(observe).not.toHaveBeenCalled();
  service.accept(packet(4n), peer);
  service.accept(packet(4n), peer);
  service.accept(packet(3n), peer);
  expect(observe).toHaveBeenCalledTimes(1);
  const text = await metrics.getMetrics();
  expect(text).toContain('cat_udp_packets_invalid_total 1');
  expect(text).toContain('cat_udp_packets_received_total{satellite="kitchen"} 1');
  expect(text).toContain('cat_udp_packets_lost_total{satellite="kitchen"} 0');
  expect(text).toContain('cat_udp_packets_stale_total{satellite="kitchen"} 2');
});

@Global()
@Module({
  providers: [{ provide: TrackerConfig, useValue: config({ udpPort: 0 }) }, LifecycleService],
  exports: [TrackerConfig, LifecycleService],
})
class UdpTestConfigModule {}

test.each([-63, -128, 127])(
  'real UDP module matches EIDs and records source, last-seen, and valid RSSI (%i)',
  async (rssi) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(12048_000);
    const module = await Test.createTestingModule({
      imports: [UdpTestConfigModule, UdpModule],
    }).compile();
    const app = module.createNestApplication();
    const client = createSocket('udp4');

    try {
      await app.init();
      const service = app.get(UdpService);
      const listener = Reflect.get(service, 'socket') as Socket;
      const received = once(listener, 'message');
      const eid = new EidService().calculate(tags[0].eik, 2048);
      await new Promise<void>((resolve, reject) => {
        client.send(
          packet(0n, 'kitchen', 1n, eid, rssi),
          listener.address().port,
          '127.0.0.1',
          (error) => (error ? reject(error) : resolve()),
        );
      });
      await received;
      const presence = app.get(PresenceService);
      expect(presence.getAllStatuses()[0]).toMatchObject({
        present: true,
        maxSignalDbm: rssi === -63 ? rssi : null,
        sources: [
          {
            name: 'satellite:kitchen',
            present: true,
            averageSignalDbm: rssi === -63 ? rssi : null,
          },
        ],
      });
      expect(presence.states.get('a')).toMatchObject({
        last_seen: 12048,
        source_name: 'satellite:kitchen',
      });
      clock.mockReturnValue(12049_000);
      service.accept(packet(0n, 'kitchen', 1n, eid), { address: '127.0.0.1', port: 1 });
      expect(presence.states.get('a')!.last_seen).toBe(12048);
      service.accept(packet(1n, 'kitchen', 1n, Buffer.alloc(20, 23)), {
        address: '127.0.0.1',
        port: 1,
      });
      expect(presence.states.get('a')!.last_seen).toBe(12048);
      const metrics = await app.get(MetricsService).getMetrics();
      expect(metrics).toContain('cat_last_seen_timestamp_seconds{tag="a"} 12048');
      expect(metrics).toContain(
        'cat_source_last_seen_timestamp_seconds{tag="a",source="satellite:kitchen"} 12048',
      );

      if (rssi === -63) {
        expect(metrics).toContain('cat_rssi_dbm{tag="a",source="satellite:kitchen"} -63');
      } else {
        expect(metrics).not.toContain('cat_rssi_dbm{tag="a",source="satellite:kitchen"}');
      }
    } finally {
      client.close();
      await app.close();
      clock.mockRestore();
    }
  },
);
