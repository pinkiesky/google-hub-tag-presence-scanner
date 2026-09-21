import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebModule, allowedClient } from '../src/web/web.module';
import { PresenceService } from '../src/presence/presence.service';
import { SqliteService } from '../src/persistence/sqlite.service';
import { WebViewService } from '../src/web/web-view.service';
import { config, manager, tags } from './helpers';
let app: INestApplication | undefined;
let m: PresenceService;
afterEach(async () => { await app?.close(); app = undefined; m?.store.onApplicationShutdown(); });
test.each([
  ['127.0.0.1', true], ['192.168.0.123', true], ['10.1.2.3', true], ['172.16.0.1', true],
  ['172.31.255.254', true], ['169.254.1.2', true], ['172.32.0.1', false], ['8.8.8.8', false],
  ['100.64.0.1', false], ['0.0.0.0', false], ['::1', false], ['invalid', false],
])('LAN peer %s is allowed=%s', (address, allowed) => expect(allowedClient(address as string)).toBe(allowed));
test('real HTTP returns current, escaped, server-rendered state without secrets or APIs', async () => {
  const cfg = config({}, { tags: [{ ...tags[0], name: '<script>Cat A</script>' }, tags[1]] });
  m = manager({}, { tags: cfg.tags });
  const module = await Test.createTestingModule({ imports: [WebModule] })
    .overrideProvider(PresenceService).useValue(m).overrideProvider(SqliteService).useValue(m.store).compile();
  app = module.createNestApplication(); await app.listen(0, '127.0.0.1');
  m.observe('a', 1110, -50, 10); m.observe('a', 1111, -70, 110); m.states.get('a')!.alert_sent = true;
  const view = app.get(WebViewService);
  const render = jest.spyOn(view, 'render'); const original = WebViewService.prototype.render;
  render.mockImplementation(() => original.call(view, 1112, 120));
  const server = app.getHttpServer() as import('node:http').Server;
  const response = await request(server).get('/').expect(200);
  expect(response.text).toContain('<!doctype html>'); expect(response.text).toContain('</html>');
  for (const value of ['&lt;script&gt;Cat A&lt;/script&gt;', 'Cat B', '<td>Present</td>', '<td>Yes</td>', '1970-01-01 00:18:31', '-60.0 dBm', 'Never seen']) expect(response.text).toContain(value);
  for (const forbidden of ['<script>', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', '/api/status', cfg.value.token, cfg.value.chatId, ...cfg.tags.map(t => t.eik.toString('hex'))]) expect(response.text).not.toContain(forbidden);
  expect(response.headers['cache-control']).toBe('no-store');
  m.observe('b', 1112, -40, 120);
  expect((await request(server).get('/')).text).toContain('-40.0 dBm');
  await request(server).get('/index.html').expect(200);
  await request(server).get('/style.css').expect('Content-Type', /text\/css/).expect(200);
  const head = await request(server).head('/').expect(200); expect(head.text).toBeUndefined();
  for (const path of ['/api/status', '/status', '/status.json', '/etc/passwd']) await request(server).get(path).expect(404);
});
test('RSSI display preserves Python ties-to-even rounding', () => {
  m = manager(); m.observe('a', 1, -58, 1); m.observe('a', 2, -58, 2);
  m.observe('a', 3, -58, 3); m.observe('a', 4, -59, 4);
  expect(new WebViewService(m).render(5, 5)).toContain('-58.2 dBm');
});
