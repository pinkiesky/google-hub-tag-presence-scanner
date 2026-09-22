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
  m.observe('a', 3602, -60);
  m.observe('a', 100, -50);
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
  });
  m.observe('a', 10, -50);
  m.observe('a', 20, -120);
  expect(m.getAllStatuses(80)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: true,
    signalDbm: -120,
  });
  expect(m.getAllStatuses(80.001)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: false,
    signalDbm: null,
  });
  expect(m.getAllStatuses(80)[1].present).toBe(false);
});
test('restart restores presence but does not present persisted RSSI as current', () => {
  const database = join(directory, 'state.db');
  m = manager({ database });
  m.observe('a', 100, -63);
  m.store.onApplicationShutdown();
  m = manager({ database });
  expect(m.getAllStatuses(110)[0]).toEqual({
    id: 'a',
    name: 'Cat A',
    present: true,
    signalDbm: null,
  });
});
test('exclusive lock prevents concurrent database ownership', () => {
  const database = join(directory, 'state.db');
  m = manager({ database });
  expect(() => manager({ database })).toThrow('exclusive service lock');
});
