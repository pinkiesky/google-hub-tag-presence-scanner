import asyncio
import sqlite3
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from bleak.exc import BleakError

from cat_tracker import ble_scanner
from cat_tracker.config import Settings
from cat_tracker.fhn.parser import FHN_UUID


async def test_scanner_retries_then_propagates_database_error(monkeypatch):
    instances, stops, delays = [], [], []

    class FakeScanner:
        def __init__(self, callback, **kwargs):
            self.callback = callback
            instances.append(self)
            assert kwargs["bluez"]["filters"]["DuplicateData"] is True
            assert len(instances) - len(stops) == 1

        async def start(self):
            if len(instances) < 3:
                raise BleakError("adapter unavailable")
            self.callback(
                None, SimpleNamespace(service_data={FHN_UUID: b"\x40" + bytes(20)}, rssi=-60)
            )

        async def stop(self):
            stops.append(self)

    async def sleep(delay):
        delays.append(delay)

    def observe(*args):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(ble_scanner, "BleakScanner", FakeScanner)
    monkeypatch.setattr(ble_scanner.asyncio, "sleep", sleep)
    matcher = Mock()
    matcher.match.return_value = "a"
    with pytest.raises(sqlite3.OperationalError):
        await ble_scanner.scan(matcher, Settings(), observe)
    assert len(instances) == len(stops) == 3
    assert delays == [5, 10]


async def test_scanner_exhaustion(monkeypatch):
    class BrokenScanner:
        def __init__(self, *args, **kwargs):
            pass

        async def start(self):
            raise BleakError("unavailable")

        async def stop(self):
            pass

    sleeps = []

    async def sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(ble_scanner, "BleakScanner", BrokenScanner)
    monkeypatch.setattr(ble_scanner.asyncio, "sleep", sleep)
    with pytest.raises(RuntimeError, match="exhausted"):
        await ble_scanner.scan(Mock(), Settings(), Mock())
    assert sleeps == [5, 10, 20, 40]


async def test_scanner_shutdown_cleans_up(monkeypatch):
    started, stopped = asyncio.Event(), asyncio.Event()

    class FakeScanner:
        def __init__(self, *args, **kwargs):
            pass

        async def start(self):
            started.set()

        async def stop(self):
            stopped.set()

    monkeypatch.setattr(ble_scanner, "BleakScanner", FakeScanner)
    task = asyncio.create_task(ble_scanner.scan(Mock(), Settings(), Mock()))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stopped.is_set()


async def test_scanner_cleanup_failure_is_fatal(monkeypatch):
    class FakeScanner:
        def __init__(self, *args, **kwargs):
            pass

        async def start(self):
            raise BleakError("failed start")

        async def stop(self):
            raise BleakError("failed cleanup")

    monkeypatch.setattr(ble_scanner, "BleakScanner", FakeScanner)
    with pytest.raises(RuntimeError, match="cleanup failed"):
        await ble_scanner.scan(Mock(), Settings(), Mock())


@pytest.mark.parametrize("advertised_uuids", [[], ["0000180f-0000-1000-8000-00805f9b34fb"]])
async def test_service_data_without_advertised_fhn_uuid(monkeypatch, caplog, advertised_uuids):
    """Exercise Bleak's real BlueZ advertisement filtering without using a radio."""
    import logging
    import time

    from bleak import BleakScanner
    from bleak.backends.bluezdbus.scanner import BleakScannerBlueZDBus

    from cat_tracker.fhn.eid import calculate_eid
    from cat_tracker.fhn.matcher import Matcher
    from cat_tracker.models import Tag

    tag = Tag("cat-test", "Test", int(time.time()) - 2048, bytes(range(32)))
    eid = calculate_eid(tag.eik, 2048)
    started = asyncio.Event()

    class InjectedScanner(BleakScanner):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, backend=BleakScannerBlueZDBus, **kwargs)

        async def start(self):
            self._backend._handle_advertising_data(
                "/org/bluez/hci0/dev_00_11_22_33_44_55",
                {
                    "Address": "00:11:22:33:44:55",
                    "Alias": "Test",
                    "UUIDs": advertised_uuids,
                    "ServiceData": {FHN_UUID: b"\x40" + eid},
                    "RSSI": -62,
                },
            )
            started.set()

        async def stop(self):
            pass

    monkeypatch.setattr(ble_scanner, "BleakScanner", InjectedScanner)
    caplog.set_level(logging.INFO, logger="cat_tracker.ble_scanner")
    observe = Mock()
    task = asyncio.create_task(ble_scanner.scan(Matcher([tag]), Settings(), observe))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        observe.assert_called_once()
        assert observe.call_args.args[0] == "cat-test"
        assert observe.call_args.args[2] == -62
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert "received=1 other=0 invalid=0 unmatched=0 matched=1" in caplog.text
    assert eid.hex() not in caplog.text
