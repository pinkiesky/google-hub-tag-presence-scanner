import { CATTAG_HEADER_LENGTH, CattagFrameError, parseCattagFrame } from '../src/udp/cattag-frame';

function packet(serviceData = Buffer.from([0x40, 0x12, 0x34])): Buffer {
  const bytes = Buffer.alloc(CATTAG_HEADER_LENGTH + serviceData.length);
  bytes[0] = 0xca;
  bytes[1] = 5;
  bytes.writeUInt16BE(0x1234, 2);
  bytes.writeBigUInt64BE(0xfedcba9876543210n, 4);
  bytes.writeBigUInt64BE(0x123456789abcdef0n, 12);
  bytes.writeUInt16BE(0xfeaa, 20);
  Buffer.from([1, 2, 3, 4, 5, 6]).copy(bytes, 22);
  bytes[28] = 0xc1; // -63 dBm in two's complement.
  bytes[29] = serviceData.length;
  serviceData.copy(bytes, CATTAG_HEADER_LENGTH);

  return bytes;
}

test('parses version 5 big-endian fields and preserves address and service data', () => {
  const bytes = packet();
  const frame = parseCattagFrame(bytes);
  expect(frame).toEqual({
    version: 5,
    satelliteId: 0x1234,
    bootId: 0xfedcba9876543210n,
    sequence: 0x123456789abcdef0n,
    serviceUuid: 0xfeaa,
    address: Buffer.from([1, 2, 3, 4, 5, 6]),
    rssi: -63,
    serviceData: Buffer.from([0x40, 0x12, 0x34]),
  });
  bytes.fill(0);
  expect(frame.address).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  expect(frame.serviceData).toEqual(Buffer.from([0x40, 0x12, 0x34]));
});

test('accepts sequence zero and empty service data', () => {
  const bytes = packet(Buffer.alloc(0));
  bytes.writeBigUInt64BE(0n, 12);
  expect(parseCattagFrame(bytes).sequence).toBe(0n);
  expect(parseCattagFrame(bytes).serviceData).toHaveLength(0);
});

test.each([
  ['short header', Buffer.alloc(29), 'frame shorter than 30-byte header'],
  [
    'wrong magic',
    (() => {
      const bytes = packet();
      bytes[0] = 0;

      return bytes;
    })(),
    'invalid frame magic',
  ],
  [
    'unsupported version',
    (() => {
      const bytes = packet();
      bytes[1] = 4;

      return bytes;
    })(),
    'unsupported frame version',
  ],
  [
    'wrong UUID',
    (() => {
      const bytes = packet();
      bytes.writeUInt16BE(0x180f, 20);

      return bytes;
    })(),
    'unexpected service UUID',
  ],
  ['truncated data', packet().subarray(0, -1), 'service-data length mismatch: 32'],
  [
    'trailing data',
    Buffer.concat([packet(), Buffer.from([0])]),
    'service-data length mismatch: 34',
  ],
])('rejects %s', (_case, bytes, reason) => {
  expect(() => parseCattagFrame(bytes)).toThrow(new CattagFrameError(reason));
});

test.each([
  [0x80, -128],
  [0xc1, -63],
  [0xff, -1],
  [0x00, 0],
  [0x14, 20],
  [0x7f, 127],
])('decodes RSSI byte %i as %i dBm', (encoded, expected) => {
  const bytes = packet();
  bytes[28] = encoded;
  expect(parseCattagFrame(bytes).rssi).toBe(expected);
});
