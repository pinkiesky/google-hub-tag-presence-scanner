import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
test('JSON config and adapter/env validation', () => {
  const cfg = loadConfiguration(
    { TAG_CONFIG_PATH: path, BLUETOOTH_ADAPTER: 'hci1', PORT: '3000' },
    ['--debug-scan'],
  );
  expect(cfg.tags).toHaveLength(1);
  expect(cfg.settings.adapter).toBe(1);
  expect(cfg.settings.port).toBe(3000);
  expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, [])).toThrow('TELEGRAM_BOT_TOKEN');
});
test.each([
  { WATCHDOG_INTERVAL_SECONDS: '0' },
  { ALERT_AFTER_SECONDS: 'NaN' },
  { STARTUP_GRACE_SECONDS: '-1' },
  { DRIFT_WINDOWS: '33' },
  { DRIFT_WINDOWS: '1.5' },
  { BLUETOOTH_ADAPTER: 'bad' },
  { PORT: '65536' },
  { DATABASE_PATH: '' },
  { ALERT_AFTER_SECONDS: '30', MISSING_AFTER_SECONDS: '60' },
])('invalid settings fail clearly: %j', (env) => {
  expect(() => loadConfiguration({ TAG_CONFIG_PATH: path, ...env }, ['--debug-scan'])).toThrow();
});
test('JSON service settings, CLI path precedence and invalid-secret isolation', () => {
  writeFileSync(join(directory, 'bad.json'), '{"eik_hex":"SECRET"}');
  writeFileSync(
    path,
    JSON.stringify({
      service: { adapter: 'hci1', drift_windows: 2, port: 12345 },
      tags: [
        { id: 'good', secret_file: 'good.json' },
        { id: 'bad', secret_file: 'bad.json' },
      ],
    }),
  );
  const cfg = loadConfiguration({ TAG_CONFIG_PATH: '/not-used.json', PORT: '3000' }, [
    '--config',
    path,
    '--debug-scan',
  ]);
  expect(cfg.tags.map((t) => t.id)).toEqual(['good']);
  expect(cfg.settings.adapter).toBe(1);
  expect(cfg.settings.driftWindows).toBe(2);
  expect(cfg.settings.port).toBe(3000);
});
test.each(['[service]\nadapter="hci0"', '{"tags": SECRET}', '{"tags": [],}'])(
  'rejects non-JSON configuration without leaking input',
  (text) => {
    writeFileSync(path, text);
    expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, ['--debug-scan'])).toThrow(
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
  expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, ['--debug-scan'])).toThrow('duplicate');
  writeFileSync(path, JSON.stringify([{ id: 'a', secret_file: 'missing.json' }]));
  expect(() => loadConfiguration({ TAG_CONFIG_PATH: path }, ['--debug-scan'])).toThrow(
    'No usable tags',
  );
});
