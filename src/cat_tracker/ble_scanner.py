import asyncio
import logging
import time
from collections.abc import Callable

from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData
from bleak.exc import BleakError

from .config import Settings
from .fhn.matcher import Matcher
from .fhn.parser import FHN_UUID, parse_service_data

log = logging.getLogger(__name__)


async def scan(
    matcher: Matcher, settings: Settings, observe: Callable[[str, float, int], None]
) -> None:
    """One scanner at a time; periodic restart also recovers silent D-Bus loss."""
    loop = asyncio.get_running_loop()
    failure: asyncio.Future[None] = loop.create_future()
    counts = {"received": 0, "other": 0, "invalid": 0, "unmatched": 0, "matched": 0}
    latest_rssi: dict[str, int] = {}

    def report() -> None:
        log.info(
            "BLE scan summary: adapter=%s received=%d other=%d invalid=%d unmatched=%d matched=%d tags=%s",
            settings.adapter,
            counts["received"],
            counts["other"],
            counts["invalid"],
            counts["unmatched"],
            counts["matched"],
            ", ".join(f"{tag}: {rssi} dBm" for tag, rssi in sorted(latest_rssi.items())) or "none",
        )
        for key in counts:
            counts[key] = 0
        latest_rssi.clear()

    def callback(_device: BLEDevice, advertisement: AdvertisementData) -> None:
        if failure.done():
            return
        try:
            counts["received"] += 1
            if not any(uuid.lower() == FHN_UUID for uuid in advertisement.service_data):
                counts["other"] += 1
                return
            eid = parse_service_data(advertisement.service_data)
            if eid is None:
                counts["invalid"] += 1
                return
            tag_id = matcher.match(eid)
            if tag_id is not None:
                observe(tag_id, time.time(), advertisement.rssi)
                counts["matched"] += 1
                latest_rssi[tag_id] = advertisement.rssi
            else:
                counts["unmatched"] += 1
        except Exception as error:  # noqa: BLE001 - propagate callback failures to supervising task
            # Bleak callback exceptions otherwise only reach the event-loop logger.
            failure.set_exception(error)

    failures = 0
    while True:
        started = time.monotonic()
        try:
            matcher.refresh(time.time())
            log.info(
                "Starting BLE scanner: adapter=%s service_data=%s UUID_filter=off drift_windows=%d",
                settings.adapter,
                FHN_UUID,
                settings.drift_windows,
            )
            scanner = BleakScanner(
                callback,
                # ServiceData UUIDs need not appear in the advertised service UUID list.
                # Bleak's UUID filter would drop those packets before our callback.
                bluez={"adapter": settings.adapter, "filters": {"DuplicateData": True}},
            )
            try:
                async with asyncio.timeout(30):
                    await scanner.start()
                log.info("BLE scanner started")
                next_report = time.monotonic() + 30
                while time.monotonic() - started < settings.scanner_cycle_seconds:
                    if failure.done():
                        failure.result()
                    matcher.refresh(time.time())
                    if time.monotonic() >= next_report:
                        report()
                        next_report = time.monotonic() + 30
                    await asyncio.sleep(1)
            finally:
                try:
                    async with asyncio.timeout(15):
                        await scanner.stop()
                    report()
                    log.info("BLE scanner stopped")
                except (BleakError, OSError, TimeoutError):
                    # Do not create another scanner if ownership was not released.
                    raise RuntimeError("BLE scanner cleanup failed") from None
            failures = 0
            log.info("Refreshing BLE discovery after scheduled scan cycle")
        except (BleakError, OSError, TimeoutError) as error:
            if failure.done():
                failure.result()
            failures = 1 if time.monotonic() - started > 60 else failures + 1
            log.error("BLE scanner error (%s), attempt %d", type(error).__name__, failures)
            if failures >= 5:
                raise RuntimeError("BLE recovery exhausted") from None
            delay = min(60, 5 * 2 ** (failures - 1))
            log.warning("Retrying BLE scanner in %d seconds", delay)
            await asyncio.sleep(delay)
