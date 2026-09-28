const { createCipheriv, createECDH } = require('node:crypto');

const ORDER = 0x0100000000000000000001f4c8f927aed3ca752257n;

function calculateEid(tag, nowSeconds) {
  const beaconSeconds = Math.floor(nowSeconds - tag.pairDate + tag.clockOffsetSeconds);
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
  const cipher = createCipheriv('aes-256-ecb', tag.eik, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(block), cipher.final()]);
  const scalar = BigInt(`0x${encrypted.toString('hex')}`) % ORDER;

  if (scalar === 0n) {
    throw new Error('Invalid zero EID scalar');
  }

  const curve = createECDH('secp160r1');
  curve.setPrivateKey(Buffer.from(scalar.toString(16).padStart(40, '0'), 'hex'));

  return curve.getPublicKey(undefined, 'compressed').subarray(1);
}

module.exports = { calculateEid };
