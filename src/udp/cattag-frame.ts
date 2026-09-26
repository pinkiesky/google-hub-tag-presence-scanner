export const CATTAG_FRAME_MAGIC = 0xca;
export const CATTAG_FRAME_VERSION = 5;
export const CATTAG_HEADER_LENGTH = 29;
export const CATTAG_SERVICE_UUID = 0xfeaa;

export interface CattagFrame {
  readonly version: 5;
  readonly satelliteId: number;
  readonly bootId: bigint;
  readonly sequence: bigint;
  readonly serviceUuid: 0xfeaa;
  /** Six address bytes in the order sent by the satellite. */
  readonly address: Buffer;
  /** Unmodified service-data bytes following the header. */
  readonly serviceData: Buffer;
}

export class CattagFrameError extends Error {}

export function parseCattagFrame(packet: Buffer): CattagFrame {
  if (packet.length < CATTAG_HEADER_LENGTH) {
    throw new CattagFrameError('frame shorter than 29-byte header');
  }

  if (packet[0] !== CATTAG_FRAME_MAGIC) {
    throw new CattagFrameError('invalid frame magic');
  }

  if (packet[1] !== CATTAG_FRAME_VERSION) {
    throw new CattagFrameError('unsupported frame version');
  }

  const serviceUuid = packet.readUInt16BE(20);

  if (serviceUuid !== CATTAG_SERVICE_UUID) {
    throw new CattagFrameError('unexpected service UUID');
  }

  const dataLength = packet[28];

  if (packet.length !== CATTAG_HEADER_LENGTH + dataLength) {
    throw new CattagFrameError('service-data length mismatch');
  }

  return {
    version: CATTAG_FRAME_VERSION,
    satelliteId: packet.readUInt16BE(2),
    bootId: packet.readBigUInt64BE(4),
    sequence: packet.readBigUInt64BE(12),
    serviceUuid: CATTAG_SERVICE_UUID,
    address: Buffer.from(packet.subarray(22, 28)),
    serviceData: Buffer.from(packet.subarray(CATTAG_HEADER_LENGTH)),
  };
}
