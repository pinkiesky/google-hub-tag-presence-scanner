export function validRssi(rssi: number | null): rssi is number {
  return typeof rssi === 'number' && Number.isFinite(rssi) && rssi >= -120 && rssi <= 20;
}
