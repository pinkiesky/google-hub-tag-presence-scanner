import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SqliteService } from '../src/persistence/sqlite.service';
import { PresenceService } from '../src/presence/presence.service';
import { allowedClient, WebModule } from '../src/web/web.module';
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

test('one page polls the live tag API and never embeds tag data in HTML', async () => {
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
  const server = app.getHttpServer() as import('node:http').Server;

  const page = await request(server).get('/').expect(200);
  expect(page.text).toMatch(/<!doctype html>/i);
  expect(page.text).toContain('id="tags"');
  expect(page.text).toContain('src="/app.js"');
  expect(page.text).not.toContain('<script>Cat A</script>');
  expect(page.text).not.toContain(cfg.tags[0].eik.toString('hex'));
  expect(page.headers['cache-control']).toBe('no-store');
  expect(page.headers['content-security-policy']).toContain("script-src 'self'");
  expect((await request(server).head('/').expect(200)).text).toBeUndefined();

  const script = await request(server)
    .get('/app.js')
    .expect('Content-Type', /text\/javascript/)
    .expect(200);
  expect(script.text).toContain("fetch('/api/tags'");
  expect(script.text).toContain('setInterval(refresh, 1000)');
  expect(script.text).toContain('title.textContent = tag.name');
  expect(script.text).toContain('name.textContent = source.name');
  await request(server)
    .get('/style.css')
    .expect('Content-Type', /text\/css/)
    .expect(200);

  const initial = await request(server).get('/api/tags').expect(200);
  expect(initial.body).toEqual({
    tags: [
      {
        id: 'a',
        name: '<script>Cat A</script>',
        present: false,
        maxSignalDbm: null,
        sources: [],
      },
      {
        id: 'b',
        name: 'Cat B',
        present: false,
        maxSignalDbm: null,
        sources: [],
      },
    ],
  });
  expect(initial.headers['cache-control']).toBe('no-store');
  expect(initial.text).not.toContain(cfg.tags[0].eik.toString('hex'));

  const now = Date.now() / 1000;
  m.observe('a', now, -70, '<script>source</script>');
  expect((await request(server).get('/api/tags').expect(200)).body.tags[0]).toEqual({
    id: 'a',
    name: '<script>Cat A</script>',
    present: true,
    maxSignalDbm: -70,
    sources: [{ name: '<script>source</script>', present: true, averageSignalDbm: -70 }],
  });

  for (const path of ['/index.html', '/api/status', '/status', '/status.json']) {
    await request(server).get(path).expect(404);
  }
});
