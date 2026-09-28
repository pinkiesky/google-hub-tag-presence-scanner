export const CATTAG_FRAME_MAGIC = 0xca;
export const CATTAG_FRAME_VERSION = 7;
export const CATTAG_HEADER_LENGTH = 44;
export const CATTAG_SERVICE_UUID = 0xfeaa;

const SATELLITE_NAME_OFFSET = 2;
const SATELLITE_NAME_LENGTH = 16;

export interface CattagFrame {
  readonly version: 7;
  readonly satelliteName: string;
  readonly bootId: bigint;
  readonly sequence: bigint;
  readonly serviceUuid: 0xfeaa;
  /** Six address bytes in the order sent by the satellite. */
  readonly address: Buffer;
  /** Signed int8 signal strength in dBm. */
  readonly rssi: number;
  /** Unmodified service-data bytes following the header. */
  readonly serviceData: Buffer;
}

export class CattagFrameError extends Error {}

export function parseCattagFrame(packet: Buffer): CattagFrame {
  if (packet.length < CATTAG_HEADER_LENGTH) {
    throw new CattagFrameError('frame shorter than 44-byte header');
  }

  if (packet[0] !== CATTAG_FRAME_MAGIC) {
    throw new CattagFrameError('invalid frame magic');
  }

  if (packet[1] !== CATTAG_FRAME_VERSION) {
    throw new CattagFrameError('unsupported frame version');
  }

  const serviceUuid = packet.readUInt16BE(34);

  if (serviceUuid !== CATTAG_SERVICE_UUID) {
    throw new CattagFrameError('unexpected service UUID');
  }

  const dataLength = packet[43];

  if (packet.length !== CATTAG_HEADER_LENGTH + dataLength) {
    throw new CattagFrameError(`service-data length mismatch: ${packet.length}`);
  }

  const nameBytes = packet.subarray(
    SATELLITE_NAME_OFFSET,
    SATELLITE_NAME_OFFSET + SATELLITE_NAME_LENGTH,
  );
  const nameEnd = nameBytes.indexOf(0);

  if (
    nameEnd === 0 ||
    (nameEnd !== -1 && nameBytes.subarray(nameEnd + 1).some((byte) => byte !== 0))
  ) {
    throw new CattagFrameError('invalid satellite name padding');
  }

  let satelliteName: string;

  try {
    satelliteName = new TextDecoder('utf-8', { fatal: true }).decode(
      nameBytes.subarray(0, nameEnd === -1 ? nameBytes.length : nameEnd),
    );
  } catch {
    throw new CattagFrameError('invalid satellite name encoding');
  }

  return {
    version: CATTAG_FRAME_VERSION,
    satelliteName,
    bootId: packet.readBigUInt64BE(18),
    sequence: packet.readBigUInt64BE(26),
    serviceUuid: CATTAG_SERVICE_UUID,
    address: Buffer.from(packet.subarray(36, 42)),
    rssi: packet.readInt8(42),
    serviceData: Buffer.from(packet.subarray(CATTAG_HEADER_LENGTH)),
  };
}
