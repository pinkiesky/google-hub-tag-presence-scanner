export interface SatelliteConfig {
  motherUrl: string;
  satelliteId: string;
  adapter: number;
  scannerCycleSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SatelliteConfig {
  let url: URL;

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

  const adapterText = env.BLUETOOTH_ADAPTER ?? '0';
  const adapter = Number(adapterText.replace(/^hci/, ''));

  if (!/^(hci)?\d+$/.test(adapterText) || !Number.isSafeInteger(adapter)) {
    throw new Error('Invalid BLUETOOTH_ADAPTER');
  }

  const scannerCycleSeconds = Number(env.SCANNER_CYCLE_SECONDS ?? '300');

  if (!Number.isFinite(scannerCycleSeconds) || scannerCycleSeconds <= 0) {
    throw new Error('Invalid SCANNER_CYCLE_SECONDS');
  }

  return Object.freeze({ motherUrl: url.origin, satelliteId, adapter, scannerCycleSeconds });
}
