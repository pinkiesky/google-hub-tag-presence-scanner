from unittest.mock import patch

import pytest

from cat_tracker.fhn.eid import calculate_eid
from cat_tracker.fhn.matcher import Matcher
from cat_tracker.fhn.parser import FHN_UUID, parse_service_data
from cat_tracker.models import Tag

KEY = bytes(range(32))


@pytest.mark.parametrize("size", [20, 32])
def test_eid_against_independent_openssl_curve(size):
    # cryptography uses OpenSSL, independent of the production ecdsa implementation.
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    clock = 0x12345400
    plaintext = bytes.fromhex("ff" * 11 + "0a12345400" + "00" * 11 + "0a12345400")
    encryptor = Cipher(algorithms.AES(KEY), modes.ECB()).encryptor()
    scalar = int.from_bytes(encryptor.update(plaintext) + encryptor.finalize(), "big")
    if size == 32:
        order = int("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
        expected = (
            ec.derive_private_key(scalar % order, ec.SECP256R1()).public_key().public_numbers().x
        )
    else:
        # Independent affine double-and-add on SEC2 secp160r1 parameters.
        p = 2**160 - 2**31 - 1
        n = int("0100000000000000000001f4c8f927aed3ca752257", 16)
        g = (
            int("4a96b5688ef573284664698968c38bb913cbfc82", 16),
            int("23a628553168947d59dcc912042351377ac5fb32", 16),
        )

        def add(a, b):
            if a is None:
                return b
            if b is None:
                return a
            x, y = a
            u, v = b
            if x == u and (y + v) % p == 0:
                return None
            slope = (
                (3 * x * x - 3) * pow(2 * y, -1, p) if a == b else (v - y) * pow(u - x, -1, p)
            ) % p
            rx = (slope * slope - x - u) % p
            return rx, (slope * (x - rx) - y) % p

        result, point, k = None, g, scalar % n
        while k:
            if k & 1:
                result = add(result, point)
            point, k = add(point, point), k >> 1
        expected = result[0]
    assert calculate_eid(KEY, clock + 123, size) == expected.to_bytes(size, "big")


def test_matching_cache_drift_wrap_and_unknown():
    tag = Tag("a", "Cat A", 10000, KEY)
    matcher = Matcher([tag], 2)
    matcher.refresh(10000 + 2048)
    assert matcher.match(calculate_eid(KEY, 1024)) == "a"
    assert matcher.match(calculate_eid(KEY, 4096, 32)) == "a"
    assert matcher.match(b"unknown") is None
    with patch("cat_tracker.fhn.matcher.calculate_eid") as calculate:
        matcher.refresh(10000 + 2100)
        calculate.assert_not_called()
    matcher.refresh(10000 + 3072)
    assert matcher.match(calculate_eid(KEY, 5120)) == "a"
    assert calculate_eid(KEY, -1024) == calculate_eid(KEY, 2**32 - 1024)


@pytest.mark.parametrize("size", [20, 32])
def test_parser(size):
    eid = bytes(range(size))
    for frame in (0x40, 0x41):
        assert parse_service_data({FHN_UUID: bytes([frame]) + eid + b"\x12"}) == eid
    assert parse_service_data({FHN_UUID.upper(): b"\x40" + eid}) == eid
    assert parse_service_data({FHN_UUID: b"\x41" + eid}) is None
    for data in (b"", b"\x00" + eid, b"\x40" + eid[:-1], b"\x40" + eid + b"123"):
        assert parse_service_data({FHN_UUID: data}) is None
    assert parse_service_data({"other": b"\x40" + eid}) is None


def test_invalid_key_and_size():
    with pytest.raises(ValueError):
        calculate_eid(b"short", 0)
    with pytest.raises(ValueError):
        calculate_eid(KEY, 0, 16)


@pytest.mark.parametrize(
    "size,expected",
    [
        (20, "e221355b8ba1d8fea8a20448cb055e7df632e49f"),
        (32, "e0c98494cf97b294bf66bc5e8caef7671b233417b2922f85c4d73399d81e44cb"),
    ],
)
def test_fixed_regression_vector_and_match(size, expected):
    # Synthetic-key vectors cross-checked by the independent calculation above.
    assert calculate_eid(KEY, 0x12345400, size).hex() == expected
    matcher = Matcher([Tag("known", "Cat", 1000, KEY)])
    matcher.refresh(1000 + 0x12345400)
    assert matcher.match(bytes.fromhex(expected)) == "known"


def test_default_window_matches_working_prototype_tolerance():
    from cat_tracker.config import Settings

    tag = Tag("a", "Cat A", 10000, KEY)
    matcher = Matcher([tag], Settings().drift_windows)
    matcher.refresh(tag.pair_date + 32 * 1024)
    for offset in (-16, 16):
        for size in (20, 32):
            assert matcher.match(calculate_eid(KEY, (32 + offset) * 1024, size)) == "a"
    assert matcher.match(calculate_eid(KEY, 49 * 1024)) is None
