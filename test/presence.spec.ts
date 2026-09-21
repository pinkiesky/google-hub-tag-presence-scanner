import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manager } from './helpers';
import { PresenceService } from '../src/presence/presence.service';
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
test('strict thresholds, independent tags, recovery once and repeated absence', () => {
  m = manager({ startupGraceSeconds: 120 });
  m.observe('a', 0, -70);
  m.observe('b', 0, -80);
  m.tick(60, 60);
  expect(m.states.get('a')!.missing_since).toBeNull();
  m.tick(61, 61);
  expect(m.states.get('a')!.missing_since).toBe(0);
  m.tick(3600, 3600);
  expect(m.claim(3600, 3600)).toBeNull();
  m.observe('b', 3601, -120);
  m.tick(3601, 3601);
  const alert = m.claim(3601, 3601)!;
  expect(alert.tag_id).toBe('a');
  expect(alert.kind).toBe('absence');
  expect(m.states.get('a')!.alert_sent).toBe(false);
  m.delivered(alert);
  expect(m.states.get('a')!.alert_sent).toBe(true);
  m.tick(3610, 3610);
  expect(m.claim(3610, 3610)).toBeNull();
  m.observe('a', 4000, -57);
  const recovery = m.claim(4000, 4000)!;
  expect(recovery.kind).toBe('recovery');
  expect(recovery.message).toContain('1 h 6 min');
  m.delivered(recovery);
  m.observe('a', 4001, -58);
  expect(m.claim(4001, 4001)).toBeNull();
  expect(m.states.get('a')!.missing_since).toBeNull();
  m.observe('b', 7602, -80);
  m.tick(7602, 7602);
  expect(m.claim(7602, 7602)!.kind).toBe('absence');
});
test('restart preserves timer, never-seen creation time, grace and confirmed alert', () => {
  const database = join(directory, 'state.db');
  m = manager({ database, startupGraceSeconds: 120 });
  m.observe('a', 100, -63);
  m.store.onApplicationShutdown();
  jest.setSystemTime(3100000);
  m = manager({ database, startupGraceSeconds: 120 });
  expect(m.states.get('a')!.last_seen).toBe(100);
  expect(m.states.get('b')!.created_at).toBe(0);
  m.tick(4000, 119);
  expect(m.claim(4000, 119)).toBeNull();
  m.tick(4001, 120);
  const alert = m.claim(4001, 120)!;
  expect(alert.tag_id).toBe('a');
  m.delivered(alert);
  m.store.onApplicationShutdown();
  m = manager({ database });
  expect(m.states.get('a')!.alert_sent).toBe(true);
  expect(m.claim(4100, 1)!.tag_id).toBe('b');
});
test('failed alerts do not block other tags and durable recovery retries survive restart', () => {
  const database = join(directory, 'state.db');
  m = manager({ database });
  m.tick(3601, 3601);
  let item = m.claim(3601, 3601)!;
  m.failed(item, 3601);
  expect(m.states.get('a')!.alert_sent).toBe(false);
  const other = m.claim(3602, 3602)!;
  expect(other.tag_id).toBe('b');
  m.delivered(other);
  expect(m.claim(3630, 3630)).toBeNull();
  item = m.claim(3631, 3631)!;
  m.delivered(item);
  m.observe('a', 4000, -50);
  const recovery = m.claim(4000, 4000)!;
  m.failed(recovery, 4000);
  m.observe('a', 4001, -51);
  m.store.onApplicationShutdown();
  m = manager({ database });
  const retried = m.claim(4030, 4030)!;
  expect(retried.id).toBe(recovery.id);
  m.delivered(retried);
  expect(m.claim(4031, 4031)).toBeNull();
});
test.each([false, true])(
  'return during delivery, failed=%s, preserves episode and order',
  (failed) => {
    const database = join(directory, 'state.db');
    m = manager({ database });
    m.observe('b', 3601, -70);
    m.tick(3601, 3601);
    let item = m.claim(3601, 3601)!;
    m.observe('a', 3602, -60);
    if (failed) {
      m.failed(item, 3603);
      expect(m.claim(3604, 3604)).toBeNull();
      m.store.onApplicationShutdown();
      m = manager({ database });
      item = m.claim(3633, 3633)!;
      expect(item.kind).toBe('absence');
    }
    m.delivered(item);
    expect(m.states.get('a')!.alert_sent).toBe(false);
    const recovery = m.claim(3634, 3634)!;
    expect(recovery.kind).toBe('recovery');
    m.delivered(recovery);
    expect(m.claim(3635, 3635)).toBeNull();
  },
);
test('unsent stale alert canceled on observation; backward wall clock corrected', () => {
  m = manager();
  m.observe('b', 3601, -70);
  m.tick(3601, 3601);
  m.observe('a', 3602, -60);
  expect(m.claim(3602, 3602)).toBeNull();
  m.observe('a', 100, -50);
  expect(m.states.get('a')!.last_seen).toBe(100);
});
test('five-minute arithmetic RSSI mean expires at the exact boundary', () => {
  m = manager();
  expect(m.averageRssi('a', 0)).toBeNull();
  m.observe('a', 1010, -50, 10);
  m.observe('a', 1110, -70, 110);
  expect(m.averageRssi('a', 120)).toBe(-60);
  expect(m.averageRssi('a', 310)).toBe(-70);
  expect(m.averageRssi('a', 410)).toBeNull();
  expect(m.averageRssi('b', 410)).toBeNull();
});
test('exclusive lock prevents concurrent database ownership', () => {
  const database = join(directory, 'state.db');
  m = manager({ database });
  expect(() => manager({ database })).toThrow('exclusive service lock');
});
