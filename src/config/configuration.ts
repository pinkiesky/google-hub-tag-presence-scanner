import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { Logger } from '@nestjs/common';
import { Tag } from '../tags/tag.types';

export interface Settings {
  readonly alertAfterSeconds: number;
  readonly startupGraceSeconds: number;
  readonly watchdogIntervalSeconds: number;
  readonly missingAfterSeconds: number;
  readonly driftWindows: number;
  readonly scannerCycleSeconds: number;
  readonly adapter: number;
  readonly database: string;
  readonly port: number;
}
export interface Configuration {
  readonly settings: Settings;
  readonly tags: readonly Tag[];
  readonly token: string;
  readonly chatId: string;
  readonly debugScan: boolean;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected configuration object');
  return value as Record<string, unknown>;
}
function readConfiguration(env: NodeJS.ProcessEnv = process.env, args = process.argv.slice(2)): Configuration {
  const debugScan = args.includes('--debug-scan');
  const configIndex = args.indexOf('--config');
  if (configIndex >= 0 && !args[configIndex + 1]) throw new Error('--config needs a path');
  const path = args[configIndex + 1] && configIndex >= 0 ? args[configIndex + 1] :
    env.TAG_CONFIG_PATH || '/etc/cat-tracker/config.toml';
  let raw: Record<string, unknown>;
  try {
    const text = readFileSync(path, 'utf8');
    const parsed: unknown = path.endsWith('.toml') ? parse(text) : JSON.parse(text);
    raw = Array.isArray(parsed) ? { tags: parsed } : object(parsed);
  } catch { throw new Error('Cannot read tag configuration (expected TOML or JSON)'); }
  const service = raw.service === undefined ? {} : object(raw.service);
  function number(name: string, legacy: string, fallback: number, zero = false): number {
    const value = env[name] ?? service[legacy] ?? fallback;
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw new Error(`Invalid ${name}`);
    const n = Number(value);
    if (!Number.isFinite(n) || (zero ? n < 0 : n <= 0)) throw new Error(`Invalid ${name}`);
    return n;
  }
  const adapter = String(env.BLUETOOTH_ADAPTER ?? service.adapter ?? 'hci0');
  if (!/^(hci)?\d+$/.test(adapter)) throw new Error('Invalid BLUETOOTH_ADAPTER');
  const database = env.DATABASE_PATH ?? service.database ?? '/var/lib/cat-tracker/presence.sqlite3';
  if (typeof database !== 'string' || !database.trim()) throw new Error('Invalid DATABASE_PATH');
  const settings: Settings = Object.freeze({
    alertAfterSeconds: number('ALERT_AFTER_SECONDS', 'alert_after_seconds', 3600),
    startupGraceSeconds: number('STARTUP_GRACE_SECONDS', 'startup_grace_seconds', 120, true),
    watchdogIntervalSeconds: number('WATCHDOG_INTERVAL_SECONDS', 'watchdog_interval_seconds', 30),
    missingAfterSeconds: number('MISSING_AFTER_SECONDS', 'missing_after_seconds', 60),
    driftWindows: number('DRIFT_WINDOWS', 'drift_windows', 16),
    scannerCycleSeconds: number('SCANNER_CYCLE_SECONDS', 'scanner_cycle_seconds', 300),
    adapter: Number(adapter.replace(/^hci/, '')),
    database,
    port: number('PORT', 'port', 15432),
  });
  if (settings.missingAfterSeconds > settings.alertAfterSeconds) throw new Error('MISSING_AFTER_SECONDS exceeds ALERT_AFTER_SECONDS');
  if (!Number.isInteger(settings.driftWindows) || settings.driftWindows > 32) throw new Error('DRIFT_WINDOWS must be 1–32');
  if (!Number.isInteger(settings.port) || settings.port > 65535) throw new Error('Invalid PORT');
  if (!Number.isSafeInteger(settings.adapter) || !settings.database.trim()) throw new Error('Invalid adapter or database');
  if (!Array.isArray(raw.tags)) throw new Error('No tags configured');
  const ids = new Set<string>(), keys = new Set<string>(), tags: Tag[] = [];
  for (const value of raw.tags) {
    const entry = object(value), id = entry.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error('Invalid or duplicate tag ID');
    ids.add(id);
    try {
      if (typeof entry.secret_file !== 'string') throw new Error();
      const secret = object(JSON.parse(readFileSync(resolve(dirname(path), entry.secret_file), 'utf8')));
      const { name, pair_date: pairDate, eik_hex: key } = secret;
      const offset = entry.clock_offset_seconds ?? 0;
      if ((secret.version ?? 1) !== 1 || typeof name !== 'string' || !name.trim() || name.trim().length > 128 ||
        typeof pairDate !== 'number' || !Number.isInteger(pairDate) || pairDate < 0 || pairDate >= 2 ** 40 ||
        typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key) || keys.has(key.toLowerCase()) ||
        typeof offset !== 'number' || !Number.isInteger(offset) || Math.abs(offset) >= 2 ** 32) throw new Error();
      keys.add(key.toLowerCase());
      tags.push(Object.freeze({ id, name: name.trim(), pairDate, eik: Buffer.from(key, 'hex'), clockOffsetSeconds: offset }));
    } catch { new Logger('Configuration').error(`Tag ${id} disabled: invalid or unreadable secret/configuration`); }
  }
  if (!tags.length) throw new Error('No usable tags configured');
  const token = env.TELEGRAM_BOT_TOKEN ?? '', chatId = env.TELEGRAM_CHAT_ID ?? '';
  if (!debugScan && (!token.trim() || !chatId.trim())) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
  return Object.freeze({ settings, tags: Object.freeze(tags), token, chatId, debugScan });
}

export class ConfigurationError extends Error {}
export function loadConfiguration(env: NodeJS.ProcessEnv = process.env, args = process.argv.slice(2)): Configuration {
  try { return readConfiguration(env, args); }
  catch (error) {
    // readConfiguration only exposes our fixed, sanitized validation messages.
    throw new ConfigurationError(error instanceof Error ? error.message : 'Invalid configuration');
  }
}
