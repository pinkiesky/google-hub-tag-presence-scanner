import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import { loadConfiguration } from '../src/config/configuration';

let directory: string, path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cat-config-'));
  path = join(directory, 'tags.json');
  writeFileSync(
    join(directory, 'good.json'),
    JSON.stringify({ name: 'Cat', pair_date: 1000, eik_hex: 'ab'.repeat(32) }),
  );
  writeFileSync(path, JSON.stringify({ tags: [{ id: 'good', secret_file: 'good.json' }] }));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
test('JSON config and env validation', () => {
  const cfg = loadConfiguration({ TAG_CONFIG_PATH: path, PORT: '3000' }, []);
  expect(cfg.tags).toHaveLength(1);
  expect(cfg.settings.port).toBe(3000);
  expect(cfg.settings.udpPort).toBe(15433);
  expect(loadConfiguration({ TAG_CONFIG_PATH: path }, []).tags).toHaveLength(1);
});
test.each([
  { MISSING_AFTER_SECONDS: '0' },
  { MISSING_AFTER_SECONDS: 'NaN' },
  { DRIFT_WINDOWS: '33' },
  { DRIFT_WINDOWS: '1.5' },
  { PORT: '65536' },
  { UDP_PORT: '0' },
  { UDP_PORT: '65536' },
  { UDP_PORT: '1.5' },
  { DATABASE_PATH: '' },
])('invalid settings fail clearly: %j', (env) => {
  expect(() => loadConfiguration({ TAG_CONFIG_PATH: path, ...env }, [])).toThrow();
});
test('JSON service settings, CLI path precedence and invalid-secret isolation', () => {
  writeFileSync(join(directory, 'bad.json'), '{"eik_hex":"SECRET"}');
  writeFileSync(
    path,
    JSON.stringify({
      service: { drift_windows: 2, port: 12345, udp_port: 15555 },
      tags: [
        { id: 'good', secret_file: 'good.json' },
        { id: 'bad', secret_file: 'bad.json' },
      ],
    }),
  );
  const cfg = loadConfiguration({ TAG_CONFIG_PATH: '/not-used.json', PORT: '3000' }, [
    '--config',
    path,
  ]);
  expect(cfg.tags.map((t) => t.id)).toEqual(['good']);
  expect(cfg.settings.driftWindows).toBe(2);
  expect(cfg.settings.port).toBe(3000);
  expect(cfg.settings.udpPort).toBe(15555);
});
test.each(['[service]\nadapter="hci0"', '{"tags": SECRET}', '{"tags": [],}'])(
  'rejects non-JSON configuration without leaking input',
  (text) => {
    writeFileSync(path, text);
    expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, [])).toThrow(
      'Cannot read tag configuration (expected valid JSON)',
    );
  },
);
test('duplicate IDs fail and all-invalid secrets fail', () => {
  writeFileSync(
    path,
    JSON.stringify([
      { id: 'a', secret_file: 'good.json' },
      { id: 'a', secret_file: 'good.json' },
    ]),
  );
  expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, [])).toThrow('duplicate');
  writeFileSync(path, JSON.stringify([{ id: 'a', secret_file: 'missing.json' }]));
  expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, [])).toThrow('No usable tags');
});

test.each([
  { missing_after_seconds: true },
  { missing_after_seconds: [] },
  { missing_after_seconds: '' },
  { missing_after_seconds: 'Infinity' },
  { drift_windows: 0 },
  { drift_windows: 33 },
  { port: null, udp_port: 65536 },
  { port: 1.5 },
  { database: '   ' },
  { database: 123 },
])('validates normalized service settings: %j', (service) => {
  writeFileSync(
    path,
    JSON.stringify({ service, tags: [{ id: 'good', secret_file: 'good.json' }] }),
  );
  expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, [])).toThrow();
});

test('environment overrides JSON before validation; defaults and numeric strings remain supported', () => {
  writeFileSync(
    path,
    JSON.stringify({
      service: {
        port: 'invalid',
        udp_port: '65535',
        missing_after_seconds: '0.5',
        drift_windows: '32',
        obsolete: true,
      },
      tags: [{ id: 'good', secret_file: 'good.json', metadata: 'ignored' }],
    }),
  );
  const cfg = loadConfiguration({ TAG_CONFIG_PATH: path, PORT: '1' }, []);
  expect(cfg.settings).toMatchObject({
    port: 1,
    udpPort: 65535,
    missingAfterSeconds: 0.5,
    driftWindows: 32,
  });
  expect(cfg.tags[0].clockOffsetSeconds).toBe(0);
  expect(Object.isFrozen(cfg.settings)).toBe(true);
  expect(Object.isFrozen(cfg.tags[0])).toBe(true);
});

test.each([
  { version: 2 },
  { version: '1' },
  { name: '' },
  { name: '   ' },
  { name: 123 },
  { name: 'x'.repeat(129) },
  { pair_date: -1 },
  { pair_date: 1.5 },
  { pair_date: 2 ** 40 },
  { pair_date: '1000' },
  { eik_hex: 'not-a-key' },
  { eik_hex: 'ab'.repeat(32) + '\n' },
  { eik_hex: 123 },
])('invalid secret disables only its tag: %j', (invalid) => {
  writeFileSync(
    join(directory, 'bad.json'),
    JSON.stringify({
      version: 1,
      name: 'Bad',
      pair_date: 1000,
      eik_hex: 'cd'.repeat(32),
      ...invalid,
    }),
  );
  writeFileSync(
    path,
    JSON.stringify({
      tags: [
        { id: 'bad', secret_file: 'bad.json' },
        { id: 'good', secret_file: 'good.json' },
      ],
    }),
  );
  expect(loadConfiguration({ TAG_CONFIG_PATH: path }, []).tags.map((tag) => tag.id)).toEqual([
    'good',
  ]);
});

test.each([
  { secret_file: null },
  { secret_file: 12 },
  { clock_offset_seconds: '1' },
  { clock_offset_seconds: 1.5 },
  { clock_offset_seconds: 2 ** 32 },
  { clock_offset_seconds: -(2 ** 32) },
])('invalid tag options disable only that tag: %j', (invalid) => {
  writeFileSync(
    path,
    JSON.stringify({
      tags: [
        { id: 'bad', secret_file: 'good.json', ...invalid },
        { id: 'good', secret_file: 'good.json' },
      ],
    }),
  );
  expect(loadConfiguration({ TAG_CONFIG_PATH: path }, []).tags.map((tag) => tag.id)).toEqual([
    'good',
  ]);
});

test('secret boundaries, trimming and nullish defaults are retained', () => {
  writeFileSync(
    join(directory, 'good.json'),
    JSON.stringify({
      version: null,
      name: '  Cat  ',
      pair_date: 2 ** 40 - 1,
      eik_hex: 'AB'.repeat(32),
      model: 'ignored',
    }),
  );
  writeFileSync(
    path,
    JSON.stringify([
      { id: 'good', secret_file: 'good.json', clock_offset_seconds: -(2 ** 32) + 1 },
    ]),
  );
  const tag = loadConfiguration({ TAG_CONFIG_PATH: path }, []).tags[0];
  expect(tag).toMatchObject({
    name: 'Cat',
    pairDate: 2 ** 40 - 1,
    clockOffsetSeconds: -(2 ** 32) + 1,
  });
  expect(tag.eik.toString('hex')).toBe('ab'.repeat(32));
});

test('duplicate keys are case insensitive and disable the later tag', () => {
  writeFileSync(
    join(directory, 'duplicate.json'),
    JSON.stringify({ name: 'Duplicate', pair_date: 0, eik_hex: 'AB'.repeat(32) }),
  );
  writeFileSync(
    path,
    JSON.stringify([
      { id: 'good', secret_file: 'good.json' },
      { id: 'duplicate', secret_file: 'duplicate.json' },
    ]),
  );
  expect(loadConfiguration({ TAG_CONFIG_PATH: path }, []).tags.map((tag) => tag.id)).toEqual([
    'good',
  ]);
});

test.each([null, [], { tags: {} }, { service: [], tags: [] }, { service: null, tags: [] }])(
  'rejects malformed configuration structure: %j',
  (value) => {
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, [])).toThrow();
  },
);

test.each([null, 123, 'bad/id', 'good\n', 'a'.repeat(65)])(
  'invalid tag identity fails startup: %j',
  (id) => {
    writeFileSync(path, JSON.stringify([{ id, secret_file: 'good.json' }]));
    expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, [])).toThrow(
      'Invalid or duplicate tag ID',
    );
  },
);

test('configuration errors and secret validation never log raw input or paths', () => {
  const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

  try {
    writeFileSync(path, '{"PRIVATE_MARKER":');
    expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, [])).toThrow(
      'Cannot read tag configuration',
    );
    expect(consoleError).not.toHaveBeenCalled();
    writeFileSync(
      join(directory, 'good.json'),
      JSON.stringify({ name: 'PRIVATE_MARKER', pair_date: 'bad', eik_hex: 'SECRET_MARKER' }),
    );
    writeFileSync(path, JSON.stringify([{ id: 'good', secret_file: 'good.json' }]));
    expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, [])).toThrow('No usable tags');
    expect(logger).toHaveBeenCalledWith(
      'Tag good disabled: invalid or unreadable secret/configuration',
    );
    const messages = JSON.stringify(logger.mock.calls);
    expect(messages).not.toContain('PRIVATE_MARKER');
    expect(messages).not.toContain('SECRET_MARKER');
    expect(messages).not.toContain(directory);
  } finally {
    logger.mockRestore();
    consoleError.mockRestore();
  }
});
