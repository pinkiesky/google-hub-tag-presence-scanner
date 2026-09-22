import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { TrackerConfig } from '../src/config/config.service';
import { EidService } from '../src/fhn/eid.service';
import { FhnModule } from '../src/fhn/fhn.module';
import { TagMatcherService } from '../src/fhn/tag-matcher.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { TagObservationService } from '../src/observations/tag-observation.service';
import { SqliteService } from '../src/persistence/sqlite.service';
import { PresenceService } from '../src/presence/presence.service';
import { WebModule } from '../src/web/web.module';
import { WebViewService } from '../src/web/web-view.service';
import { config, manager, tags } from './helpers';

let presence: PresenceService;
let metrics: MetricsService;
let observations: TagObservationService;
let app: INestApplication | undefined;
beforeEach(() => {
  presence = manager();
  metrics = new MetricsService(presence);
  observations = new TagObservationService(presence, metrics);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  presence.store.onApplicationShutdown();
});

test('each matched observation updates both consumers and all samples count independently', async () => {
  const observePresence = jest.spyOn(presence, 'observe');
  const observeMetrics = jest.spyOn(metrics, 'observeTag');
  observations.observe({ tagId: 'a', rssi: -63, timestamp: 100.5 });
  expect(observePresence).toHaveBeenCalledWith('a', 100.5, -63);
  expect(observeMetrics).toHaveBeenCalledWith('a', -63, 100.5);
  expect(await metrics.getMetrics()).toContain('cat_rssi_dbm{tag="a"} -63');
  observations.observe({ tagId: 'a', rssi: -61, timestamp: 101 });
  observations.observe({ tagId: 'a', rssi: -65, timestamp: 102.25 });
  const text = await metrics.getMetrics();

  for (const line of [
    '# TYPE cat_rssi_dbm gauge',
    '# TYPE cat_rssi_samples_total counter',
    '# TYPE cat_rssi_offset_sum_total counter',
    '# TYPE cat_last_seen_timestamp_seconds gauge',
    'cat_rssi_dbm{tag="a"} -65',
    'cat_rssi_samples_total{tag="a"} 3',
    'cat_rssi_offset_sum_total{tag="a"} 171',
    'cat_last_seen_timestamp_seconds{tag="a"} 102.25',
    'cat_rssi_samples_total{tag="b"} 0',
    'cat_rssi_offset_sum_total{tag="b"} 0',
  ]) {
    expect(text).toContain(line);
  }

  expect(text).not.toContain('cat_rssi_dbm{tag="b"}');
  observations.observe({ tagId: 'b', rssi: -80, timestamp: 103 });
  expect(await metrics.getMetrics()).toContain('cat_rssi_samples_total{tag="a"} 3');
  expect(await metrics.getMetrics()).toContain('cat_rssi_dbm{tag="b"} -80');
});

test('unknown gauges omitted, configured counters initialized, registry isolated', async () => {
  const text = await metrics.getMetrics();

  for (const tag of tags) {
    expect(text).toContain(`cat_rssi_samples_total{tag="${tag.id}"} 0`);
    expect(text).toContain(`cat_rssi_offset_sum_total{tag="${tag.id}"} 0`);
    expect(text).not.toContain(`cat_rssi_dbm{tag="${tag.id}"}`);
    expect(text).not.toContain(`cat_last_seen_timestamp_seconds{tag="${tag.id}"}`);
  }

  observations.observe({ tagId: 'a', rssi: -63, timestamp: 100 });
  const second = new MetricsService(presence);
  expect(await second.getMetrics()).toContain('cat_rssi_samples_total{tag="a"} 0');
  expect(await metrics.getMetrics()).toContain('cat_rssi_samples_total{tag="a"} 1');
});

test('restores persisted last-seen without inventing RSSI or restoring counters', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cat-metrics-'));
  presence.store.onApplicationShutdown();

  try {
    presence = manager({ database: join(directory, 'state.db') });
    presence.observe('a', 1790103073.5, -63);
    presence.store.onApplicationShutdown();
    presence = manager({ database: join(directory, 'state.db') });
    metrics = new MetricsService(presence);
    const text = await metrics.getMetrics();
    expect(text).toContain('cat_last_seen_timestamp_seconds{tag="a"} 1790103073.5');
    expect(text).toContain('cat_rssi_samples_total{tag="a"} 0');
    expect(text).not.toContain('cat_rssi_dbm{tag="a"}');
  } finally {
    presence.store.onApplicationShutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([NaN, Infinity, -Infinity, -121, 127, 21])(
  'RSSI %s cannot corrupt metrics or gate presence',
  async (rssi) => {
    observations.observe({ tagId: 'a', rssi, timestamp: 100 });
    expect(presence.getAllStatuses(100)[0]).toMatchObject({ present: true, signalDbm: null });
    const text = await metrics.getMetrics();
    expect(text).toContain('cat_last_seen_timestamp_seconds{tag="a"} 100');
    expect(text).toContain('cat_rssi_samples_total{tag="a"} 0');
    expect(text).not.toContain('cat_rssi_dbm{tag="a"}');
    expect(text).not.toMatch(/NaN|Infinity/);
  },
);

test('RSSI boundary -120 increments samples and keeps the offset counter nonnegative', async () => {
  observations.observe({ tagId: 'a', rssi: -120, timestamp: 100 });
  expect(await metrics.getMetrics()).toContain('cat_rssi_offset_sum_total{tag="a"} 0');
  expect(await metrics.getMetrics()).toContain('cat_rssi_samples_total{tag="a"} 1');
  expect(presence.getAllStatuses(100)[0].present).toBe(true);
});

test('unknown tags and invalid timestamps leave both consumers unchanged', async () => {
  const original = await metrics.getMetrics();
  observations.observe({ tagId: 'unknown', rssi: -63, timestamp: 100 });

  for (const timestamp of [NaN, Infinity, -1]) {
    observations.observe({ tagId: 'a', rssi: -63, timestamp });
    metrics.observeTag('a', -63, timestamp);
  }

  metrics.observeTag('unknown', -63, 100);
  expect(await metrics.getMetrics()).toBe(original);
  expect(presence.states.get('a')!.last_seen).toBeNull();
});

@Global()
@Module({ providers: [{ provide: TrackerConfig, useValue: config() }], exports: [TrackerConfig] })
class TestConfigModule {}

test('real module wiring exposes read-only metrics independently of page rendering', async () => {
  const module = await Test.createTestingModule({
    imports: [TestConfigModule, FhnModule.register(false), WebModule],
  }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const matcher = app.get(TagMatcherService);
  const timestamp = 12048;
  const eid = new EidService().calculate(tags[0].eik, 2048);
  expect(matcher.observe(Buffer.alloc(20, 23), -63, timestamp)).toBeNull();

  for (const rssi of [-63, -61, -65]) {
    expect(matcher.observe(eid, rssi, timestamp)).toBe('a');
  }

  const actualMetrics = app.get(MetricsService);
  const render = jest.spyOn(app.get(WebViewService), 'render');
  const save = jest.spyOn(app.get(SqliteService), 'save');
  const crypto = jest.spyOn(app.get(EidService), 'calculate');
  const observe = jest.spyOn(app.get(TagObservationService), 'observe');
  const server = app.getHttpServer() as import('node:http').Server;
  const response = await request(server).get('/metrics').expect(200);
  // Express may reorder Content-Type parameters without changing their meaning.
  const contentTypeParts = (value: string) =>
    value
      .split(';')
      .map((part) => part.trim())
      .sort();
  expect(contentTypeParts(response.headers['content-type'] as string)).toEqual(
    contentTypeParts(actualMetrics.getContentType()),
  );
  expect(response.text).toBe(await actualMetrics.getMetrics());

  for (const [name, type] of [
    ['cat_bluetooth_adapter_up', 'gauge'],
    ['cat_bluetooth_scanner_up', 'gauge'],
    ['cat_bluetooth_scanner_restarts_total', 'counter'],
  ]) {
    expect(response.text).toContain(`# TYPE ${name} ${type}`);
    expect(response.text).toContain(`${name}{adapter="hci0"} 0`);
  }

  expect(response.text).toContain('cat_rssi_samples_total{tag="a"} 3');
  expect(response.text).toContain('cat_rssi_offset_sum_total{tag="a"} 171');
  expect(response.text).toContain('cat_rssi_dbm{tag="a"} -65');
  expect(response.text).toContain('cat_last_seen_timestamp_seconds{tag="a"} 12048');

  for (const secret of tags.map((tag) => tag.eik.toString('hex'))) {
    expect(response.text).not.toContain(secret);
  }

  expect(response.text).not.toMatch(/<!doctype|nodejs_|process_|^up[ {]/m);
  expect((await request(server).get('/metrics')).text).toBe(response.text);
  expect(render).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(crypto).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  expect(app.get(PresenceService).getAllStatuses(timestamp)[0].signalDbm).toBe(-65);
});

test('debug matcher module never opens persistence or exposes metrics', async () => {
  const module = await Test.createTestingModule({
    imports: [TestConfigModule, FhnModule.register(true)],
  })
    .overrideProvider(TrackerConfig)
    .useValue(config({}, { debugScan: true }))
    .compile();

  try {
    expect(() => module.get(SqliteService)).toThrow();
    expect(() => module.get(MetricsService)).toThrow();
    const eid = new EidService().calculate(tags[0].eik, 2048);
    expect(module.get(TagMatcherService).observe(eid, -63, 12048)).toBe('a');
  } finally {
    await module.close();
  }
});
