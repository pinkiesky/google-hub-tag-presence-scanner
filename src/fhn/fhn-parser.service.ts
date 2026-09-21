import { Injectable } from '@nestjs/common';
export const FHN_UUID = '0000feaa-0000-1000-8000-00805f9b34fb';
export function isFhnUuid(uuid: string): boolean {
  // Noble presents 16-bit UUIDs as four hex digits; Bleak used canonical UUIDs.
  return ['feaa', FHN_UUID, FHN_UUID.replaceAll('-', '')].includes(uuid.toLowerCase());
}
@Injectable()
export class FhnParserService {
  parse(serviceData: Array<{ uuid: string; data: Buffer }>): Buffer | null {
    const data = serviceData.find((item) => isFhnUuid(item.uuid))?.data;
    if (!data?.length || (data[0] !== 0x40 && data[0] !== 0x41)) return null;
    if ([22, 34].includes(data.length)) return data.subarray(1, -1);
    if (data[0] === 0x40 && [21, 33].includes(data.length)) return data.subarray(1);
    return null;
  }
}
