const { readFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

function parseTriggerLine(line) {
  if (typeof line !== 'string' || !line.trim()) {
    throw new Error('TRIGGER_LINE is required');
  }

  const steps = line.split(';').map((part) => {
    const token = part.trim();
    const pause = /^delay\s*(\d+(?:\.\d+)?)$/i.exec(token);

    if (pause) {
      const seconds = Number(pause[1]);

      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) {
        throw new Error(`Invalid delay: ${token}`);
      }

      return { type: 'delay', milliseconds: seconds * 1000 };
    }

    const observation = /^([A-Za-z0-9_-]{1,64}):(-?\d+)$/.exec(token);

    if (observation) {
      const rssi = Number(observation[2]);

      if (Number.isInteger(rssi) && rssi >= -127 && rssi <= 0) {
        return { type: 'tag', tagId: observation[1], rssi };
      }
    }

    throw new Error(`Invalid trigger step: ${token || '(empty)'}`);
  });

  if (!steps.some((step) => step.type === 'tag')) {
    throw new Error('TRIGGER_LINE needs a tag step');
  }

  if (!steps.some((step) => step.type === 'delay')) {
    throw new Error('TRIGGER_LINE needs a delay to loop safely');
  }

  return steps;
}

function loadConfig(env = process.env) {
  let url;

  try {
    url = new URL(env.MOTHER_URL ?? '');
  } catch {
    throw new Error('Invalid MOTHER_URL');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('MOTHER_URL must be an HTTP(S) origin without credentials, query or path');
  }

  const satelliteId = env.SATELLITE_ID ?? '';

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(satelliteId)) {
    throw new Error('Invalid SATELLITE_ID');
  }

  const configPath = env.TAG_CONFIG_PATH;

  if (!configPath) {
    throw new Error('TAG_CONFIG_PATH is required');
  }

  const steps = parseTriggerLine(env.TRIGGER_LINE);
  let config;

  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('Cannot read tag configuration');
  }

  const entries = Array.isArray(config) ? config : config?.tags;

  if (!Array.isArray(entries)) {
    throw new Error('Tag configuration needs a tags array');
  }

  const wanted = new Set(steps.filter((step) => step.type === 'tag').map((step) => step.tagId));
  const tags = new Map();

  for (const entry of entries) {
    if (!wanted.has(entry?.id)) {
      continue;
    }

    if (tags.has(entry.id) || typeof entry.secret_file !== 'string' || !entry.secret_file) {
      throw new Error(`Invalid tag configuration: ${entry.id}`);
    }

    let secret;

    try {
      secret = JSON.parse(readFileSync(resolve(dirname(configPath), entry.secret_file), 'utf8'));
    } catch {
      throw new Error(`Cannot read secret for tag ${entry.id}`);
    }

    if (
      !/^[0-9a-fA-F]{64}$/.test(secret?.eik_hex) ||
      !Number.isSafeInteger(secret.pair_date) ||
      secret.pair_date < 0 ||
      (entry.clock_offset_seconds !== undefined &&
        !Number.isSafeInteger(entry.clock_offset_seconds))
    ) {
      throw new Error(`Invalid secret or clock offset for tag ${entry.id}`);
    }

    tags.set(entry.id, {
      eik: Buffer.from(secret.eik_hex, 'hex'),
      pairDate: secret.pair_date,
      clockOffsetSeconds: entry.clock_offset_seconds ?? 0,
    });
  }

  for (const id of wanted) {
    if (!tags.has(id)) {
      throw new Error(`Unknown tag in TRIGGER_LINE: ${id}`);
    }
  }

  return { motherUrl: url.origin, satelliteId, steps, tags };
}

module.exports = { loadConfig, parseTriggerLine };
