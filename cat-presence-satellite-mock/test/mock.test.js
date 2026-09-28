const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const { loadConfig, parseTriggerLine } = require('../src/config');
const { calculateEid } = require('../src/eid');
const { run } = require('../src/run');

const key = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

test('parses the requested syntax, including both delay spellings', () => {
  assert.deepEqual(parseTriggerLine('tag1:-40;delay 10;tag2:-60;tag1:-45;delay5'), [
    { type: 'tag', tagId: 'tag1', rssi: -40 },
    { type: 'delay', milliseconds: 10000 },
    { type: 'tag', tagId: 'tag2', rssi: -60 },
    { type: 'tag', tagId: 'tag1', rssi: -45 },
    { type: 'delay', milliseconds: 5000 },
  ]);
});

test('rejects malformed steps and unbounded loops', () => {
  for (const line of [
    '',
    'tag1:-40',
    'delay 1',
    'tag1:-40;',
    'tag1:5;delay 1',
    'tag1:-128;delay 1',
    'tag1:-40;delay0',
    'tag1:-40;delay NaN',
  ]) {
    assert.throws(() => parseTriggerLine(line));
  }
});

test('loads mother tag fixtures and rejects unknown tags', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cat-mock-'));

  try {
    writeFileSync(
      join(directory, 'tag.json'),
      JSON.stringify({ pair_date: 1789900000, eik_hex: key }),
    );
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({ tags: [{ id: 'tag1', secret_file: 'tag.json', clock_offset_seconds: 3 }] }),
    );
    const env = {
      MOTHER_URL: 'http://127.0.0.1:15432',
      SATELLITE_ID: 'mock',
      TAG_CONFIG_PATH: join(directory, 'config.json'),
      TRIGGER_LINE: 'tag1:-40;delay5',
    };
    const config = loadConfig(env);
    assert.equal(config.tags.get('tag1').clockOffsetSeconds, 3);
    assert.equal(config.tags.get('tag1').eik.toString('hex'), key);
    assert.throws(() => loadConfig({ ...env, TRIGGER_LINE: 'tag2:-40;delay5' }), /Unknown tag/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('calculates the same rotating EID as mother', () => {
  const tag = { eik: Buffer.from(key, 'hex'), pairDate: 1789900000, clockOffsetSeconds: 0 };
  assert.equal(
    calculateEid(tag, 1789900000).toString('hex'),
    'e6cec9ca5505f86e82781bcbe75984acb3ce5e03',
  );
  assert.equal(
    calculateEid(tag, 1789901024).toString('hex'),
    '3a19ac7db9a3a9140c0faceae210ec57a127fb31',
  );
});

test('sends RPi wire payload in order and repeats the line', async () => {
  const abort = new AbortController();
  const posts = [];
  const config = {
    motherUrl: 'http://localhost:15432',
    satelliteId: 'mock',
    tags: new Map([
      ['tag1', { eik: Buffer.from(key, 'hex'), pairDate: 1789900000, clockOffsetSeconds: 0 }],
    ]),
    steps: parseTriggerLine('tag1:-40;delay 0.001;tag1:-45'),
  };
  await run(config, {
    now: () => 1789900000 * 1000,
    signal: abort.signal,
    send: async (url, options) => {
      posts.push({ url: String(url), options });

      if (posts.length === 3) {
        abort.abort();
      }

      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(
    posts.map(({ options }) => JSON.parse(options.body).rssi),
    [-40, -45, -40],
  );
  assert.equal(posts[0].url, 'http://localhost:15432/api/v1/observations');
  assert.deepEqual(JSON.parse(posts[0].options.body), {
    satelliteId: 'mock',
    serviceUuid: 'feaa',
    serviceDataHex: '40e6cec9ca5505f86e82781bcbe75984acb3ce5e03',
    rssi: -40,
  });
});
