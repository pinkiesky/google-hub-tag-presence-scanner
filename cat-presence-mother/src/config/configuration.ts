import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Logger } from '@nestjs/common';

import { Tag } from '../tags/tag.types';
import {
  ConfigurationDto,
  SettingsDto,
  TagEntryDto,
  TagIdentityDto,
  TagSecretDto,
  validateConfigurationDto,
} from './configuration.dto';

export interface Settings {
  readonly missingAfterSeconds: number;
  readonly driftWindows: number;
  readonly database: string;
  readonly port: number;
  readonly udpPort: number;
}
export interface Configuration {
  readonly settings: Settings;
  readonly tags: readonly Tag[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected configuration object');
  }

  return value as Record<string, unknown>;
}

function readConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  args = process.argv.slice(2),
): Configuration {
  const configIndex = args.indexOf('--config');

  if (configIndex >= 0 && !args[configIndex + 1]) {
    throw new Error('--config needs a path');
  }

  const path =
    args[configIndex + 1] && configIndex >= 0
      ? args[configIndex + 1]
      : env.TAG_CONFIG_PATH || '/etc/cat-tracker/config.json';
  let raw: Record<string, unknown>;

  try {
    const text = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(text);
    raw = Array.isArray(parsed) ? { tags: parsed } : object(parsed);
  } catch {
    throw new Error('Cannot read tag configuration (expected valid JSON)');
  }

  const configuration = validateConfigurationDto(
    ConfigurationDto,
    {
      service: raw.service === undefined ? {} : raw.service,
      tags: raw.tags,
    },
    { service: 'Expected configuration object', tags: 'No tags configured' },
  );
  const service = configuration.service;

  function number(name: string, field: string, fallback: number): number {
    const value = env[name] ?? service[field] ?? fallback;

    // Explicit conversion applies only to numeric service settings. Reject values
    // such as booleans, arrays and empty strings instead of coercing them.
    return (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== ''
      ? Number(value)
      : NaN;
  }

  const settings: Settings = Object.freeze(
    validateConfigurationDto(
      SettingsDto,
      {
        missingAfterSeconds: number('MISSING_AFTER_SECONDS', 'missing_after_seconds', 60),
        driftWindows: number('DRIFT_WINDOWS', 'drift_windows', 16),
        database: env.DATABASE_PATH ?? service.database ?? '/var/lib/cat-tracker/presence.sqlite3',
        port: number('PORT', 'port', 15432),
        udpPort: number('UDP_PORT', 'udp_port', 15433),
      },
      {
        missingAfterSeconds: 'Invalid MISSING_AFTER_SECONDS',
        driftWindows: 'DRIFT_WINDOWS must be 1–32',
        database: 'Invalid DATABASE_PATH',
        port: 'Invalid PORT',
        udpPort: 'Invalid UDP_PORT',
      },
    ),
  );

  const ids = new Set<string>(),
    keys = new Set<string>(),
    tags: Tag[] = [];

  for (const value of configuration.tags) {
    const rawEntry = object(value);
    const { id } = validateConfigurationDto(
      TagIdentityDto,
      { id: rawEntry.id },
      'Invalid or duplicate tag ID',
    );

    if (ids.has(id)) {
      throw new Error('Invalid or duplicate tag ID');
    }

    ids.add(id);

    try {
      const entry = validateConfigurationDto(
        TagEntryDto,
        {
          ...rawEntry,
          clock_offset_seconds: rawEntry.clock_offset_seconds ?? 0,
        },
        'Invalid tag configuration',
      );
      const rawSecret = object(
        JSON.parse(readFileSync(resolve(dirname(path), entry.secret_file), 'utf8')),
      );
      const secret = validateConfigurationDto(
        TagSecretDto,
        {
          ...rawSecret,
          version: rawSecret.version ?? 1,
          name: typeof rawSecret.name === 'string' ? rawSecret.name.trim() : rawSecret.name,
        },
        'Invalid tag secret',
      );
      const { name, pair_date: pairDate, eik_hex: key } = secret;
      const offset = entry.clock_offset_seconds;

      // Uniqueness is a cross-tag rule, rather than part of an individual DTO.
      if (keys.has(key.toLowerCase())) {
        throw new Error('Duplicate tag key');
      }

      keys.add(key.toLowerCase());
      tags.push(
        Object.freeze({
          id,
          name: name.trim(),
          pairDate,
          eik: Buffer.from(key, 'hex'),
          clockOffsetSeconds: offset,
        }),
      );
    } catch {
      new Logger('Configuration').error(
        `Tag ${id} disabled: invalid or unreadable secret/configuration`,
      );
    }
  }

  if (!tags.length) {
    throw new Error('No usable tags configured');
  }

  return Object.freeze({ settings, tags: Object.freeze(tags) });
}

export class ConfigurationError extends Error {}

export function loadConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  args = process.argv.slice(2),
): Configuration {
  try {
    return readConfiguration(env, args);
  } catch (error) {
    // readConfiguration only exposes our fixed, sanitized validation messages.
    throw new ConfigurationError(error instanceof Error ? error.message : 'Invalid configuration');
  }
}
