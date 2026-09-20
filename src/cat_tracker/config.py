import json
import logging
import math
import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .models import Tag

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Settings:
    alert_after_seconds: float = 3600
    startup_grace_seconds: float = 120
    watchdog_interval_seconds: float = 30
    missing_after_seconds: float = 60
    drift_windows: int = 16
    scanner_cycle_seconds: float = 300
    adapter: str = "hci0"
    database: str = "/var/lib/cat-tracker/presence.sqlite3"


@dataclass(frozen=True)
class Config:
    service: Settings
    tags: list[Tag]
    token: str = field(repr=False)
    chat_id: str = field(repr=False)


def load_config(path: Path, *, debug_scan: bool = False) -> Config:
    with path.open("rb") as f:
        raw = tomllib.load(f)
    settings = Settings(**raw.get("service", {}))
    for key in (
        "alert_after_seconds",
        "startup_grace_seconds",
        "watchdog_interval_seconds",
        "missing_after_seconds",
        "scanner_cycle_seconds",
    ):
        value = getattr(settings, key)
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise ValueError(f"Invalid service setting: {key}")
        if value < 0 or (value == 0 and key != "startup_grace_seconds"):
            raise ValueError(f"Invalid service setting: {key}")
    if settings.missing_after_seconds > settings.alert_after_seconds:
        raise ValueError("missing_after_seconds exceeds alert_after_seconds")
    if type(settings.drift_windows) is not int or not 1 <= settings.drift_windows <= 32:
        raise ValueError("drift_windows must be between 1 and 32")
    if not isinstance(settings.adapter, str) or not re.fullmatch(r"hci\d+", settings.adapter):
        raise ValueError("Invalid Bluetooth adapter")
    if not isinstance(settings.database, str) or not settings.database:
        raise ValueError("Invalid database path")
    tags: list[Tag] = []
    ids: set[str] = set()
    keys: set[bytes] = set()
    for entry in raw.get("tags", []):
        tag_id = entry.get("id")
        if not isinstance(tag_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", tag_id):
            raise ValueError("Tag IDs must be 1–64 letters, digits, underscores or hyphens")
        if tag_id in ids:
            raise ValueError("Duplicate tag ID")
        ids.add(tag_id)
        try:
            secret_path = Path(entry["secret_file"])
            if not secret_path.is_absolute():
                secret_path = path.parent / secret_path
            data = json.loads(secret_path.read_text())
            if data.get("version", 1) != 1:
                raise ValueError("Unsupported secret version")
            name, pair_date, key_hex = data["name"], data["pair_date"], data["eik_hex"]
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 128:
                raise ValueError("Invalid name")
            if type(pair_date) is not int or not 0 <= pair_date < 2**40:
                raise ValueError("Invalid pair_date")
            if not isinstance(key_hex, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", key_hex):
                raise ValueError("Invalid EIK")
            eik = bytes.fromhex(key_hex)
            if eik in keys:
                raise ValueError("Duplicate EIK")
            offset = entry.get("clock_offset_seconds", 0)
            if type(offset) is not int or abs(offset) >= 2**32:
                raise ValueError("Invalid clock offset")
            keys.add(eik)
            tags.append(Tag(tag_id, name.strip(), pair_date, eik, offset))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            # Never print exception text: JSON errors and input may contain secrets.
            log.error("Tag %s disabled: invalid or unreadable secret/configuration", tag_id)
    if not tags:
        raise ValueError("No usable tags configured")
    token, chat_id = os.getenv("TELEGRAM_BOT_TOKEN", ""), os.getenv("TELEGRAM_CHAT_ID", "")
    if not debug_scan and (not token.strip() or not chat_id.strip()):
        raise ValueError("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required")
    return Config(settings, tags, token, chat_id)
