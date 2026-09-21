import { ConfigService } from '@nestjs/config';
import { TrackerConfig } from '../src/config/config.service';
import { Configuration, Settings } from '../src/config/configuration';
import { SqliteService } from '../src/persistence/sqlite.service';
import { PresenceService } from '../src/presence/presence.service';
export const tags = [
  {
    id: 'a',
    name: 'Cat A',
    pairDate: 10000,
    eik: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
    clockOffsetSeconds: 0,
  },
  { id: 'b', name: 'Cat B', pairDate: 10000, eik: Buffer.alloc(32, 1), clockOffsetSeconds: 0 },
];
export function config(
  settings: Partial<Settings> = {},
  overrides: Partial<Configuration> = {},
): TrackerConfig {
  const value: Configuration = {
    settings: {
      alertAfterSeconds: 3600,
      startupGraceSeconds: 0,
      watchdogIntervalSeconds: 30,
      missingAfterSeconds: 60,
      driftWindows: 16,
      scannerCycleSeconds: 300,
      adapter: 0,
      database: ':memory:',
      port: 15432,
      ...settings,
    },
    tags,
    token: 'test-secret-token',
    chatId: 'test-chat-id',
    debugScan: false,
    ...overrides,
  };
  return new TrackerConfig(new ConfigService({ tracker: value }));
}
export function manager(settings: Partial<Settings> = {}, overrides: Partial<Configuration> = {}) {
  const cfg = config(settings, overrides),
    store = new SqliteService(cfg);
  return new PresenceService(store, cfg);
}
