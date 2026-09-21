// Explicitly invoked commissioning probe. Sends TWO labeled test messages.
// Uses an in-memory database, no radio, and never changes production state.
const { Logger } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { TrackerConfig } = require('../dist/config/config.service');
const { loadConfiguration } = require('../dist/config/configuration');
const { SqliteService } = require('../dist/persistence/sqlite.service');
const { PresenceService, wallTime } = require('../dist/presence/presence.service');
const { TelegramService } = require('../dist/notifications/telegram.service');
Logger.overrideLogger(false);
async function main() {
  const original = loadConfiguration(process.env, []);
  const value = { ...original, settings: { ...original.settings, database: ':memory:', startupGraceSeconds: 0 },
    tags: [{ id: 'migration-test', name: 'Migration test (synthetic tag, no real cat absence)', pairDate: 0, eik: Buffer.alloc(32), clockOffsetSeconds: 0 }] };
  const config = new TrackerConfig(new ConfigService({ tracker: value }));
  const store = new SqliteService(config);
  try {
    const presence = new PresenceService(store, config), telegram = new TelegramService(config);
    const now = wallTime();
    presence.observe('migration-test', now - value.settings.alertAfterSeconds - 1, -60);
    presence.tick(now);
    const absence = presence.claim();
    if (!absence || absence.kind !== 'absence') throw new Error();
    await telegram.send(absence.message); presence.delivered(absence);
    if (!presence.states.get('migration-test').alert_sent) throw new Error();
    presence.observe('migration-test', wallTime(), -55);
    const recovery = presence.claim();
    if (!recovery || recovery.kind !== 'recovery') throw new Error();
    await telegram.send(recovery.message); presence.delivered(recovery);
    if (presence.claim() !== null || presence.states.get('migration-test').alert_sent) throw new Error();
    console.log('PASS: Telegram confirmed one labeled absence and one recovery; production state untouched.');
  } finally { store.onApplicationShutdown(); }
}
main().catch(() => { console.error('Telegram commissioning probe failed; no secrets logged.'); process.exitCode = 1; });
