import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PresenceService } from '../src/presence/presence.service';
import { manager } from './helpers';

let m: PresenceService;
let directory: string;
beforeEach(() => {
  jest.useFakeTimers({ now: 0 });
  directory = mkdtempSync(join(tmpdir(), 'cat-state-'));
});
afterEach(() => {
  m?.store.onApplicationShutdown();
  rmSync(directory, { recursive: true, force: true });
  jest.useRealTimers();
});
test('backward wall clock updates the latest observation', () => {
  m = manager();
  m.observe('a', 3602, -60, 'ble:hci0');
  m.observe('a', 100, -50, 'ble:hci0');
  expect(m.states.get('a')!.last_seen).toBe(100);
  expect(m.getAllStatuses(100)[0].signalDbm).toBe(-50);
});
test('status uses latest signal and exact existing presence timeout', () => {
  m = manager();
  expect(m.getAllStatuses(0)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: false,
    signalDbm: null,
    sourceName: 'unknown',
  });
  m.observe('a', 10, -50, 'ble:hci0');
  m.observe('a', 20, -120, 'ble:hci0');
  expect(m.getAllStatuses(80)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: true,
    signalDbm: -120,
    sourceName: 'ble:hci0',
  });
  expect(m.getAllStatuses(80.001)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: false,
    signalDbm: null,
    sourceName: 'ble:hci0',
  });
  expect(m.getAllStatuses(80)[1].present).toBe(false);
});
test('restart restores presence but does not present persisted RSSI as current', () => {
  const database = join(directory, 'state.db');
  m = manager({ database });
  m.observe('a', 100, -63, 'satellite:7');
  m.store.onApplicationShutdown();
  m = manager({ database });
  expect(m.getAllStatuses(110)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: true,
    signalDbm: null,
    sourceName: 'satellite:7',
  });
});
test('exclusive lock prevents concurrent database ownership', () => {
  const database = join(directory, 'state.db');
  m = manager({ database });
  expect(() => manager({ database })).toThrow('exclusive service lock');
});

test('latest observation supplies the presence source and missing signal', () => {
  m = manager();
  m.observe('a', 100, -60, 'ble:hci0');
  expect(m.getAllStatuses(100)[0]).toMatchObject({ sourceName: 'ble:hci0', signalDbm: -60 });
  m.observe('a', 110, 127, 'satellite:7');
  expect(m.getAllStatuses(110)[0]).toMatchObject({ sourceName: 'satellite:7', signalDbm: null });
  expect(m.getAllStatuses(171)[0]).toMatchObject({ present: false, sourceName: 'satellite:7' });
});

test.each([undefined, null, '', '   '])(
  'rejects missing or blank observation source (%s)',
  (source) => {
    m = manager();
    m.observe('a', 100, -60, 'ble:hci0');
    expect(() => m.observe('a', 110, -50, source as unknown as string)).toThrow(
      'sourceName is required',
    );
    expect(m.states.get('a')).toMatchObject({ last_seen: 100, source_name: 'ble:hci0' });
    expect(m.getAllStatuses(110)[0]).toMatchObject({ signalDbm: -60, sourceName: 'ble:hci0' });
  },
);
