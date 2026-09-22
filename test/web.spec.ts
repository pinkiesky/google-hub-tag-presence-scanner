import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SqliteService } from '../src/persistence/sqlite.service';
import { PresenceService } from '../src/presence/presence.service';
import { allowedClient, WebModule } from '../src/web/web.module';
import { WebViewService } from '../src/web/web-view.service';
import { config, manager, tags } from './helpers';

let app: INestApplication | undefined;
let m: PresenceService;
afterEach(async () => {
  await app?.close();
  app = undefined;
  m?.store.onApplicationShutdown();
});
test.each([
  ['127.0.0.1', true],
  ['192.168.0.123', true],
  ['10.1.2.3', true],
  ['172.16.0.1', true],
  ['172.31.255.254', true],
  ['169.254.1.2', true],
  ['172.32.0.1', false],
  ['8.8.8.8', false],
  ['100.64.0.1', false],
  ['0.0.0.0', false],
  ['::1', false],
  ['invalid', false],
])('LAN peer %s is allowed=%s', (address, allowed) =>
  expect(allowedClient(address as string)).toBe(allowed),
);
test('real HTTP returns current, escaped, server-rendered state without secrets or APIs', async () => {
  const cfg = config({}, { tags: [{ ...tags[0], name: '<script>Cat A</script>' }, tags[1]] });
  m = manager({}, { tags: cfg.tags });
  const module = await Test.createTestingModule({ imports: [WebModule] })
    .overrideProvider(PresenceService)
    .useValue(m)
    .overrideProvider(SqliteService)
    .useValue(m.store)
    .compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  m.observe('a', 1110, -50);
  m.observe('a', 1111, -70);
  const view = app.get(WebViewService);
  const render = jest.spyOn(view, 'render');
  const original = WebViewService.prototype.render;
  render.mockImplementation(() => original.call(view, 1112));
  const server = app.getHttpServer() as import('node:http').Server;
  const response = await request(server).get('/').expect(200);
  expect(response.text).toMatch(/<!doctype html>/i);
  expect(response.text).toContain('</html>');

  for (const value of [
    '&lt;script&gt;Cat A&lt;/script&gt;',
    'Cat B',
    '<td>Present</td>',
    '-70 dBm',
    'Not present',
    '<td>—</td>',
  ]) {
    expect(response.text).toContain(value);
  }

  for (const forbidden of [
    '<script>',
    'Alert sent',
    'Last seen',
    'Average RSSI',
    'Telegram',
    'Generated at',
    'http-equiv',
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    '/api/status',
    ...cfg.tags.map((t) => t.eik.toString('hex')),
  ]) {
    expect(response.text).not.toContain(forbidden);
  }

  expect(response.headers['cache-control']).toBe('no-store');
  m.observe('b', 1112, -40);
  expect((await request(server).get('/')).text).toContain('-40 dBm');
  await request(server).get('/index.html').expect(200);
  await request(server)
    .get('/style.css')
    .expect('Content-Type', /text\/css/)
    .expect(200);
  const head = await request(server).head('/').expect(200);
  expect(head.text).toBeUndefined();

  for (const path of ['/api/status', '/status', '/status.json', '/etc/passwd']) {
    await request(server).get(path).expect(404);
  }
});
test('stale signal is hidden when the tag becomes absent', () => {
  m = manager();
  m.observe('a', 1, -59);
  const view = new WebViewService(m);
  expect(view.render(61)).toContain('-59 dBm');
  expect(view.render(62)).not.toContain('-59 dBm');
  expect(view.render(62)).toContain('<td>—</td>');
});

test('Pug treats names as escaped data, including template syntax', () => {
  const name = '#{1 + 1} & <img src=x onerror="alert(1)">';
  m = manager({}, { tags: [{ ...tags[0], name }] });
  const page = new WebViewService(m).render(5);
  expect(page).toContain('#{1 + 1} &amp; &lt;img');
  expect(page).not.toContain('<img');
  expect(page).not.toContain('{{rows}}');
});
