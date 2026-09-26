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

test('each matched observation updates both consumers', async () => {
  const observePresence = jest.spyOn(presence, 'observe');
  const observeMetrics = jest.spyOn(metrics, 'observeTag');
  observations.observe({ sourceName: 'ble:hci0', tagId: 'a', rssi: -63, timestamp: 100.5 });
  expect(observePresence).toHaveBeenCalledWith('a', 100.5, -63, 'ble:hci0');
  expect(observeMetrics).toHaveBeenCalledWith('a', -63, 100.5, 'ble:hci0');
  expect(await metrics.getMetrics()).toContain('cat_rssi_dbm{tag="a",source="ble:hci0"} -63');
  observations.observe({ sourceName: 'ble:hci0', tagId: 'a', rssi: -61, timestamp: 101 });
  observations.observe({ sourceName: 'ble:hci0', tagId: 'a', rssi: -65, timestamp: 102.25 });
  const text = await metrics.getMetrics();

  for (const line of [
    '# TYPE cat_rssi_dbm gauge',
    '# TYPE cat_last_seen_timestamp_seconds gauge',
    'cat_rssi_dbm{tag="a",source="ble:hci0"} -65',
    'cat_last_seen_timestamp_seconds{tag="a"} 102.25',
  ]) {
    expect(text).toContain(line);
  }

  expect(text).not.toContain('cat_rssi_dbm{tag="b",source="ble:hci0"}');
  observations.observe({ sourceName: 'ble:hci0', tagId: 'b', rssi: -80, timestamp: 103 });
  expect(await metrics.getMetrics()).toContain('cat_rssi_dbm{tag="a",source="ble:hci0"} -65');
  expect(await metrics.getMetrics()).toContain('cat_rssi_dbm{tag="b",source="ble:hci0"} -80');
});

test('RSSI and per-source last-seen are split by source; tag last-seen follows the latest', async () => {
  observations.observe({ sourceName: 'ble:hci0', tagId: 'a', rssi: -60, timestamp: 100 });
  observations.observe({ sourceName: 'satellite:7', tagId: 'a', rssi: -80, timestamp: 101 });
  observations.observe({ sourceName: 'satellite:7', tagId: 'a', rssi: -70, timestamp: 102 });
  observations.observe({ sourceName: 'satellite:9', tagId: 'a', rssi: NaN, timestamp: 103 });
  const text = await metrics.getMetrics();

  for (const line of [
    'cat_rssi_dbm{tag="a",source="ble:hci0"} -60',
    'cat_rssi_dbm{tag="a",source="satellite:7"} -70',
    '# TYPE cat_source_last_seen_timestamp_seconds gauge',
    'cat_source_last_seen_timestamp_seconds{tag="a",source="ble:hci0"} 100',
    'cat_source_last_seen_timestamp_seconds{tag="a",source="satellite:7"} 102',
    'cat_source_last_seen_timestamp_seconds{tag="a",source="satellite:9"} 103',
    'cat_last_seen_timestamp_seconds{tag="a"} 103',
  ]) {
    expect(text).toContain(line);
  }

  expect(text).not.toContain('cat_rssi_dbm{tag="a",source="satellite:9"}');
  expect(text).not.toContain('tag="b"');
});

test('unknown gauges omitted, registry isolated', async () => {
  const text = await metrics.getMetrics();

  for (const tag of tags) {
    expect(text).not.toContain(`cat_rssi_dbm{tag="${tag.id}"`);
    expect(text).not.toContain(`cat_last_seen_timestamp_seconds{tag="${tag.id}"}`);
  }

  observations.observe({ sourceName: 'ble:hci0', tagId: 'a', rssi: -63, timestamp: 100 });
  const second = new MetricsService(presence);
  expect(await second.getMetrics()).not.toContain('cat_rssi_dbm{tag="a"');
  expect(await metrics.getMetrics()).toContain('cat_rssi_dbm{tag="a",source="ble:hci0"} -63');
});

test('restores persisted last-seen without inventing RSSI', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cat-metrics-'));
  presence.store.onApplicationShutdown();

  try {
    presence = manager({ database: join(directory, 'state.db') });
    presence.observe('a', 1790103073.5, -63, 'ble:hci0');
    presence.observe('b', 1790103000, -63, 'ble:hci0');
    presence.store.db.prepare("UPDATE states SET source_name='unknown' WHERE tag_id='b'").run();
    presence.store.onApplicationShutdown();
    presence = manager({ database: join(directory, 'state.db') });
    metrics = new MetricsService(presence);
    const text = await metrics.getMetrics();
    expect(text).toContain('cat_last_seen_timestamp_seconds{tag="a"} 1790103073.5');
    expect(text).toContain('cat_last_seen_timestamp_seconds{tag="b"} 1790103000');
    expect(text).toContain(
      'cat_source_last_seen_timestamp_seconds{tag="a",source="ble:hci0"} 1790103073.5',
    );
    expect(text).not.toContain('cat_source_last_seen_timestamp_seconds{tag="b"');
    expect(text).not.toContain('cat_rssi_dbm{tag="a"');
  } finally {
    presence.store.onApplicationShutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([NaN, Infinity, -Infinity, -121, 127, 21])(
  'RSSI %s cannot corrupt metrics or gate presence',
  async (rssi) => {
    observations.observe({ sourceName: 'ble:hci0', tagId: 'a', rssi, timestamp: 100 });
    expect(presence.getAllStatuses(100)[0]).toMatchObject({ present: true, signalDbm: null });
    const text = await metrics.getMetrics();
    expect(text).toContain('cat_last_seen_timestamp_seconds{tag="a"} 100');
    expect(text).not.toContain('cat_rssi_dbm{tag="a"');
    expect(text).not.toMatch(/NaN|Infinity/);
  },
);

test('RSSI boundary -120 is recorded', async () => {
  observations.observe({ sourceName: 'ble:hci0', tagId: 'a', rssi: -120, timestamp: 100 });
  expect(await metrics.getMetrics()).toContain('cat_rssi_dbm{tag="a",source="ble:hci0"} -120');
  expect(presence.getAllStatuses(100)[0].present).toBe(true);
});

test('unknown tags and invalid timestamps leave both consumers unchanged', async () => {
  const original = await metrics.getMetrics();
  observations.observe({ sourceName: 'ble:hci0', tagId: 'unknown', rssi: -63, timestamp: 100 });

  for (const timestamp of [NaN, Infinity, -1]) {
    observations.observe({ sourceName: 'ble:hci0', tagId: 'a', rssi: -63, timestamp });
    metrics.observeTag('a', -63, timestamp, 'ble:hci0');
  }

  metrics.observeTag('unknown', -63, 100, 'ble:hci0');

  for (const source of [undefined, '', '   ']) {
    metrics.observeTag('a', -63, 100, source as unknown as string);
  }

  expect(await metrics.getMetrics()).toBe(original);
  expect(presence.states.get('a')!.last_seen).toBeNull();
});

@Global()
@Module({ providers: [{ provide: TrackerConfig, useValue: config() }], exports: [TrackerConfig] })
class TestConfigModule {}

test('real module wiring exposes read-only metrics independently of page rendering', async () => {
  const module = await Test.createTestingModule({
    imports: [TestConfigModule, FhnModule, WebModule],
  }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const matcher = app.get(TagMatcherService);
  const timestamp = 12048;
  const eid = new EidService().calculate(tags[0].eik, 2048);
  expect(matcher.observe(Buffer.alloc(20, 23), -63, timestamp, 'ble:hci0')).toBeNull();

  for (const rssi of [-63, -61, -65]) {
    expect(matcher.observe(eid, rssi, timestamp, 'ble:hci0')).toBe('a');
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

  expect(response.text).toContain('cat_rssi_dbm{tag="a",source="ble:hci0"} -65');
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
