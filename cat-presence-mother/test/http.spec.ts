import { Global, Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { TrackerConfig } from '../src/config/config.service';
import { EidService } from '../src/fhn/eid.service';
import { HttpObservationModule } from '../src/http/http.module';
import { MetricsService } from '../src/metrics/metrics.service';
import { PresenceService } from '../src/presence/presence.service';
import { WebModule } from '../src/web/web.module';
import { config, tags } from './helpers';

@Global()
@Module({ providers: [{ provide: TrackerConfig, useValue: config() }], exports: [TrackerConfig] })
class TestConfigModule {}

let app: NestExpressApplication;
const observation = { satelliteId: 'pi-1', serviceUuid: 'feaa', serviceDataHex: '00', rssi: -63 };
beforeEach(async () => {
  const module = await Test.createTestingModule({
    imports: [TestConfigModule, HttpObservationModule, WebModule],
  }).compile();
  app = module.createNestApplication<NestExpressApplication>();
  app.useLogger(false);
  app.useBodyParser('json', { limit: '4kb' });
  await app.listen(0, '127.0.0.1');
});
afterEach(async () => {
  await app.close();
});

test('HTTP raw advertisement updates presence and metrics via cryptographic matching', async () => {
  const now = Date.now() / 1000;
  const eid = new EidService().calculate(
    tags[0].eik,
    Math.floor((now - tags[0].pairDate) / 1024) * 1024,
  );
  const packet = {
    ...observation,
    serviceDataHex: Buffer.concat([Buffer.from([0x40]), eid]).toString('hex'),
  };
  await request(app.getHttpServer()).post('/api/v1/observations').send(packet).expect(204);
  expect(app.get(PresenceService).getAllStatuses()[0]).toMatchObject({
    present: true,
    maxSignalDbm: -63,
    sources: [{ name: 'satellite-rpi:pi-1', present: true, averageSignalDbm: -63 }],
  });
  expect(await app.get(MetricsService).getMetrics()).toContain(
    'cat_rssi_dbm{tag="a",source="satellite-rpi:pi-1"} -63',
  );
  await request(app.getHttpServer())
    .post('/api/v1/observations')
    .send({ ...packet, satelliteId: 'pi-2', rssi: 127 })
    .expect(204);
  expect(app.get(PresenceService).getAllStatuses()[0]).toMatchObject({
    present: true,
    maxSignalDbm: -63,
    sources: [
      { name: 'satellite-rpi:pi-1', present: true, averageSignalDbm: -63 },
      { name: 'satellite-rpi:pi-2', present: true, averageSignalDbm: null },
    ],
  });
  const metrics = await app.get(MetricsService).getMetrics();
  expect(metrics).toContain(
    'cat_source_last_seen_timestamp_seconds{tag="a",source="satellite-rpi:pi-2"}',
  );
  expect(metrics).not.toContain('cat_rssi_dbm{tag="a",source="satellite-rpi:pi-2"}');
  expect(metrics).not.toContain('cat_bluetooth_');
});

test.each([
  {},
  { ...observation, satelliteId: '../x' },
  { ...observation, satelliteId: 'pi-1\n' },
  { ...observation, satelliteId: 123 },
  { ...observation, satelliteId: 'a'.repeat(65) },
  { ...observation, serviceUuid: null },
  { ...observation, serviceUuid: ['feaa'] },
  { ...observation, serviceDataHex: 12 },
  { ...observation, serviceDataHex: '00\n' },
  { ...observation, rssi: true },
  { ...observation, serviceUuid: 'abcd' },
  { ...observation, serviceDataHex: 'a' },
  { ...observation, serviceDataHex: 'xx' },
  { ...observation, serviceDataHex: '' },
  { ...observation, serviceDataHex: 'ab'.repeat(256) },
  { ...observation, rssi: null },
  { ...observation, rssi: '-63' },
  [],
])('rejects malformed observations %j', async (body) => {
  await request(app.getHttpServer()).post('/api/v1/observations').send(body).expect(400);
  expect(app.get(PresenceService).getAllStatuses()[0].present).toBe(false);
});

test('unsupported and unmatched data succeeds without presence updates', async () => {
  for (const serviceDataHex of ['00', '40' + 'ab'.repeat(20)]) {
    await request(app.getHttpServer())
      .post('/api/v1/observations')
      .send({ ...observation, serviceDataHex })
      .expect(204);
  }

  expect(app.get(PresenceService).getAllStatuses()[0].present).toBe(false);
});

test('rejects invalid JSON and bodies over 4 KiB', async () => {
  await request(app.getHttpServer())
    .post('/api/v1/observations')
    .type('json')
    .send('{')
    .expect(400);
  await request(app.getHttpServer())
    .post('/api/v1/observations')
    .send({ ...observation, extra: 'x'.repeat(4096) })
    .expect(413);
});

test('LAN policy uses socket peer and ignores forwarded headers', async () => {
  await request(app.getHttpServer())
    .post('/api/v1/observations')
    .set('X-Forwarded-For', '8.8.8.8')
    .send(observation)
    .expect(204);
  // IPv6 loopback is outside the existing IPv4-only policy.
  await app.close();
  await app.listen(0, '::1');
  await request(await app.getUrl())
    .post('/api/v1/observations')
    .set('X-Forwarded-For', '192.168.1.1')
    .send(observation)
    .expect(403);
});

test.each(['satelliteId', 'serviceUuid', 'serviceDataHex', 'rssi'])(
  'requires %s',
  async (field) => {
    const body: Record<string, unknown> = { ...observation };
    delete body[field];
    const response = await request(app.getHttpServer())
      .post('/api/v1/observations')
      .send(body)
      .expect(400);
    expect(response.body.message).toEqual(expect.arrayContaining([expect.stringContaining(field)]));
  },
);

test.each([
  'feaa',
  'FEAA',
  '0000FEAA-0000-1000-8000-00805F9B34FB',
  '0000feaa00001000800000805f9b34fb',
])('accepts supported UUID spelling %s and boundary lengths', async (serviceUuid) => {
  await request(app.getHttpServer())
    .post('/api/v1/observations')
    .send({
      ...observation,
      serviceUuid,
      satelliteId: 'a'.repeat(64),
      serviceDataHex: 'AB'.repeat(255),
      extra: 'ignored',
    })
    .expect(204);
});

test('rejects non-finite JSON numbers without coercing them', async () => {
  await request(app.getHttpServer())
    .post('/api/v1/observations')
    .type('json')
    .send('{"satelliteId":"pi-1","serviceUuid":"feaa","serviceDataHex":"00","rssi":1e400}')
    .expect(400);
});
