"""Google FHN specification, table 17; clock is relative to beacon provisioning."""

from Cryptodome.Cipher import AES
from ecdsa.curves import NIST256p, SECP160r1

ROTATION_SECONDS = 1024


def calculate_eid(eik: bytes, beacon_seconds: int, size: int = 20) -> bytes:
    if len(eik) != 32 or size not in (20, 32):
        raise ValueError("Expected a 32-byte EIK and 20- or 32-byte EID")
    timestamp = ((beacon_seconds & 0xFFFFFFFF) & ~1023).to_bytes(4, "big")
    block = b"\xff" * 11 + b"\x0a" + timestamp + b"\x00" * 11 + b"\x0a" + timestamp
    curve = SECP160r1 if size == 20 else NIST256p
    scalar = int.from_bytes(AES.new(eik, AES.MODE_ECB).encrypt(block), "big") % curve.order
    if scalar == 0:
        raise ValueError("Invalid zero EID scalar")
    return (scalar * curve.generator).x().to_bytes(size, "big")
