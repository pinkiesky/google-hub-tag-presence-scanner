import { CATTAG_HEADER_LENGTH, CattagFrameError, parseCattagFrame } from '../src/udp/cattag-frame';

function packet(serviceData = Buffer.from([0x40, 0x12, 0x34])): Buffer {
  const bytes = Buffer.alloc(CATTAG_HEADER_LENGTH + serviceData.length);
  bytes[0] = 0xca;
  bytes[1] = 7;
  bytes.writeBigUInt64BE(0xfedcba9876543210n, 18);
  bytes.writeBigUInt64BE(0x123456789abcdef0n, 26);
  bytes.writeUInt16BE(0xfeaa, 34);
  Buffer.from([1, 2, 3, 4, 5, 6]).copy(bytes, 36);
  bytes[42] = 0xc1; // -63 dBm in two's complement.
  bytes[43] = serviceData.length;
  bytes.write('kitchen', 2, 'utf8');
  serviceData.copy(bytes, CATTAG_HEADER_LENGTH);

  return bytes;
}

test('parses version 7 with zero-padded name and preserves address and service data', () => {
  const bytes = packet();
  const frame = parseCattagFrame(bytes);
  expect(frame).toEqual({
    version: 7,
    satelliteName: 'kitchen',
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
  bytes.writeBigUInt64BE(0n, 26);
  expect(parseCattagFrame(bytes).sequence).toBe(0n);
  expect(parseCattagFrame(bytes).serviceData).toHaveLength(0);
});

test.each([
  ['short header', packet().subarray(0, 43), 'frame shorter than 44-byte header'],
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
      bytes[1] = 6;

      return bytes;
    })(),
    'unsupported frame version',
  ],
  [
    'wrong UUID',
    (() => {
      const bytes = packet();
      bytes.writeUInt16BE(0x180f, 34);

      return bytes;
    })(),
    'unexpected service UUID',
  ],
  ['truncated data', packet().subarray(0, -1), 'service-data length mismatch: 46'],
  [
    'trailing data',
    Buffer.concat([packet(), Buffer.from([0])]),
    'service-data length mismatch: 48',
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
  bytes[42] = encoded;
  expect(parseCattagFrame(bytes).rssi).toBe(expected);
});

test('accepts a full 16-byte name', () => {
  const named = packet();
  named.write('1234567890abcdef', 2, 'utf8');
  expect(parseCattagFrame(named).satelliteName).toBe('1234567890abcdef');
});

test.each([
  ['empty', (bytes: Buffer) => bytes.fill(0, 2, 18), 'invalid satellite name padding'],
  [
    'nonzero padding',
    (bytes: Buffer) => {
      bytes[10] = 1;
    },
    'invalid satellite name padding',
  ],
  [
    'invalid UTF-8',
    (bytes: Buffer) => {
      bytes[2] = 0xff;
    },
    'invalid satellite name encoding',
  ],
])('rejects %s satellite name', (_case, mutate, reason) => {
  const bytes = packet();
  mutate(bytes);
  expect(() => parseCattagFrame(bytes)).toThrow(new CattagFrameError(reason));
});
