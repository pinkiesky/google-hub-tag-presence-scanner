import { createCipheriv } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { weierstrass } from '@noble/curves/abstract/weierstrass.js';
import { p256 } from '@noble/curves/nist.js';

export const ROTATION_SECONDS = 1024;
// SEC2 secp160r1 curve parameters.
const secp160r1 = weierstrass({
  p: 0xffffffffffffffffffffffffffffffff7fffffffn,
  n: 0x0100000000000000000001f4c8f927aed3ca752257n,
  h: 1n,
  a: 0xffffffffffffffffffffffffffffffff7ffffffcn,
  b: 0x1c97befc54bd7a8b65acf89f81d4d4adc565fa45n,
  Gx: 0x4a96b5688ef573284664698968c38bb913cbfc82n,
  Gy: 0x23a628553168947d59dcc912042351377ac5fb32n,
});
@Injectable()
export class EidService {
  calculate(eik: Buffer, beaconSeconds: number, size = 20): Buffer {
    if (eik.length !== 32 || ![20, 32].includes(size) || !Number.isSafeInteger(beaconSeconds)) {
      throw new Error('Expected a 32-byte EIK, integer clock and 20- or 32-byte EID');
    }

    const timestamp = Buffer.alloc(4);
    timestamp.writeUInt32BE((beaconSeconds & ~1023) >>> 0);
    const block = Buffer.concat([
      Buffer.alloc(11, 255),
      Buffer.from([10]),
      timestamp,
      Buffer.alloc(11),
      Buffer.from([10]),
      timestamp,
    ]);
    const cipher = createCipheriv('aes-256-ecb', eik, null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(block), cipher.final()]);
    const curve = size === 20 ? secp160r1 : p256.Point;
    const scalar = BigInt(`0x${encrypted.toString('hex')}`) % curve.CURVE().n;

    if (scalar === 0n) {
      throw new Error('Invalid zero EID scalar');
    }

    const x = curve.BASE.multiply(scalar).toAffine().x;

    return Buffer.from(x.toString(16).padStart(size * 2, '0'), 'hex');
  }
}
