/** Wire contract for POST /api/v1/observations. No tag-specific information. */
export interface Observation {
  satelliteId: string;
  serviceUuid: string;
  serviceDataHex: string;
  rssi: number;
}

export function isFeaa(uuid: string): boolean {
  return [
    'feaa',
    '0000feaa-0000-1000-8000-00805f9b34fb',
    '0000feaa00001000800000805f9b34fb',
  ].includes(uuid.toLowerCase());
}
