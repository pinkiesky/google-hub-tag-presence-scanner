import { loadConfig } from '../src/config';

const env = { MOTHER_URL: 'http://192.168.1.2:15432', SATELLITE_ID: 'pi-1' };
test('defaults and adapter syntax', () => {
  expect(loadConfig(env)).toEqual({
    motherUrl: env.MOTHER_URL,
    satelliteId: 'pi-1',
    adapter: 0,
    scannerCycleSeconds: 300,
  });
  expect(loadConfig({ ...env, BLUETOOTH_ADAPTER: 'hci1' }).adapter).toBe(1);
  expect(loadConfig({ ...env, BLUETOOTH_ADAPTER: '2' }).adapter).toBe(2);
});
test.each([
  { MOTHER_URL: '' },
  { MOTHER_URL: 'ftp://host' },
  { MOTHER_URL: 'http://user:password@host' },
  { MOTHER_URL: 'http://host/path' },
  { SATELLITE_ID: '' },
  { SATELLITE_ID: 'a/b' },
  { SATELLITE_ID: 'a'.repeat(65) },
  { BLUETOOTH_ADAPTER: '-1' },
  { BLUETOOTH_ADAPTER: 'wrong' },
  { SCANNER_CYCLE_SECONDS: '0' },
  { SCANNER_CYCLE_SECONDS: '' },
  { SCANNER_CYCLE_SECONDS: 'Infinity' },
])('rejects invalid environment %j', (invalid) => {
  expect(() => loadConfig({ ...env, ...invalid })).toThrow();
});
