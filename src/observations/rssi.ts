export function validRssi(rssi: number): boolean {
  return Number.isFinite(rssi) && rssi >= -120 && rssi <= 20;
}
