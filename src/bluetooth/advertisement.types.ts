export interface Advertisement {
  rssi: number;
  advertisement: { serviceData: Array<{ uuid: string; data: Buffer }> };
}
