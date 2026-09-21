import argparse
import asyncio
import fcntl
import logging
import os
import signal
import sqlite3
import time
from pathlib import Path

import httpx

from .ble_scanner import scan
from .config import Config, load_config
from .fhn.matcher import Matcher
from .notifications.telegram import Telegram, deliver_notifications
from .presence.manager import PresenceManager
from .status_page import serve_status
from .storage.sqlite import Store

log = logging.getLogger(__name__)


async def watchdog(manager: PresenceManager) -> None:
    while True:
        manager.tick(time.time(), time.monotonic())
        await asyncio.sleep(manager.settings.watchdog_interval_seconds)


async def run(config: Config, debug_scan: bool) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    matcher = Matcher(config.tags, config.service.drift_windows)
    store: Store | None = None
    tasks: list[asyncio.Task] = []
    # Prevent two service processes from dispatching the same durable outbox.
    lock = None
    client = httpx.AsyncClient(timeout=httpx.Timeout(15, connect=10), follow_redirects=False)
    try:
        if debug_scan:

            def observed(tag: str, now: float, rssi: int) -> None:
                log.info("Tag matched: %s RSSI=%d dBm", tag, rssi)

            tasks.append(asyncio.create_task(scan(matcher, config.service, observed)))
        else:
            dbpath = Path(config.service.database)
            dbpath.parent.mkdir(parents=True, exist_ok=True)
            # Startup only; lifetime extends through task cancellation in finally.
            lock = open(str(dbpath) + ".lock", "a")  # noqa: ASYNC230, SIM115
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            store = Store(str(dbpath))
            manager = PresenceManager(
                store, config.tags, config.service, time.time(), time.monotonic()
            )
            tasks.extend(
                [
                    asyncio.create_task(scan(matcher, config.service, manager.observe)),
                    asyncio.create_task(watchdog(manager)),
                    asyncio.create_task(serve_status(manager)),
                    asyncio.create_task(
                        deliver_notifications(
                            manager, Telegram(client, config.token, config.chat_id)
                        )
                    ),
                ]
            )
        tasks.append(asyncio.create_task(stop.wait()))
        log.info("Service started; monitoring %d tags", len(config.tags))
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await client.aclose()
        if store:
            store.close()
        if lock:
            lock.close()
        log.info("Service stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="Local BLE cat presence monitoring")
    parser.add_argument("--config", type=Path, default=Path("/etc/cat-tracker/config.toml"))
    parser.add_argument("--debug", action="store_true")
    parser.add_argument(
        "--debug-scan",
        action="store_true",
        help="Print matches/RSSI; no database or Telegram credentials required",
    )
    args = parser.parse_args()
    os.umask(0o077)
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # These libraries may log request URLs (which include Telegram tokens).
    for name in ("httpx", "httpcore", "bleak", "dbus_fast"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    try:
        config = load_config(args.config, debug_scan=args.debug_scan)
        asyncio.run(run(config, args.debug_scan))
    except KeyboardInterrupt:
        pass
    except Exception as error:  # noqa: BLE001 - sanitize fatal errors at process boundary
        log.error(
            "%s (%s)",
            "Database error"
            if isinstance(error, sqlite3.Error)
            else "Service failed; check configuration, permissions and Bluetooth",
            type(error).__name__,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
