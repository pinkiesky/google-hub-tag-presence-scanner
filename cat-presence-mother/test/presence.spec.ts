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

test('aggregate max and per-source averages use only the rolling presence window', () => {
  m = manager();
  expect(m.getAllStatuses(0)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: false,
    maxSignalDbm: null,
    sources: [],
  });

  m.observe('a', 10, -70, 'satellite:1');
  m.observe('a', 20, -50, 'satellite:1');
  m.observe('a', 30, -80, 'satellite:2');
  m.observe('a', 40, -60, 'satellite:2');
  expect(m.getAllStatuses(40)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: true,
    maxSignalDbm: -50,
    sources: [
      { name: 'satellite:1', present: true, averageSignalDbm: -60 },
      { name: 'satellite:2', present: true, averageSignalDbm: -70 },
    ],
  });

  // The first source is absent and no longer contributes to the maximum.
  expect(m.getAllStatuses(81)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: true,
    maxSignalDbm: -60,
    sources: [
      { name: 'satellite:1', present: false, averageSignalDbm: null },
      { name: 'satellite:2', present: true, averageSignalDbm: -70 },
    ],
  });
  expect(m.getAllStatuses(91)[0].maxSignalDbm).toBe(-60);
  expect(m.getAllStatuses(101)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: false,
    maxSignalDbm: null,
    sources: [
      { name: 'satellite:1', present: false, averageSignalDbm: null },
      { name: 'satellite:2', present: false, averageSignalDbm: null },
    ],
  });
});

test('invalid RSSI keeps source present and is excluded from averages and max', () => {
  m = manager();
  m.observe('a', 10, -70, 'satellite:1');
  m.observe('a', 11, 127, 'satellite:1');
  m.observe('a', 12, NaN, 'satellite:2');
  expect(m.getAllStatuses(12)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: true,
    maxSignalDbm: -70,
    sources: [
      { name: 'satellite:1', present: true, averageSignalDbm: -70 },
      { name: 'satellite:2', present: true, averageSignalDbm: null },
    ],
  });
});

test('window observations and source states survive a restart', () => {
  const database = join(directory, 'state.db');
  m = manager({ database });
  m.observe('a', 100, -63, 'satellite:7');
  m.observe('a', 101, -67, 'satellite:7');
  m.store.onApplicationShutdown();
  m = manager({ database });
  expect(m.getAllStatuses(110)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: true,
    maxSignalDbm: -63,
    sources: [{ name: 'satellite:7', present: true, averageSignalDbm: -65 }],
  });
});

test('backward wall clock updates the latest observation', () => {
  m = manager();
  m.observe('a', 3602, -60, 'ble:hci0');
  m.observe('a', 100, -50, 'ble:hci0');
  expect(m.states.get('a')!.last_seen).toBe(100);
  expect(m.getAllStatuses(100)[0].maxSignalDbm).toBe(-50);
});

test('exclusive lock prevents concurrent database ownership', () => {
  const database = join(directory, 'state.db');
  m = manager({ database });
  expect(() => manager({ database })).toThrow('exclusive service lock');
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
    expect(m.getAllStatuses(110)[0]).toMatchObject({
      maxSignalDbm: -60,
      sources: [{ name: 'ble:hci0', present: true, averageSignalDbm: -60 }],
    });
  },
);
