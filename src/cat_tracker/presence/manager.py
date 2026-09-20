import logging
from datetime import UTC, datetime

from ..config import Settings
from ..models import Notification, Tag
from ..storage.sqlite import Store

log = logging.getLogger(__name__)


def duration(seconds: float) -> str:
    minutes = max(0, int(seconds)) // 60
    return f"{minutes // 60} h {minutes % 60} min"


class PresenceManager:
    def __init__(
        self, store: Store, tags: list[Tag], settings: Settings, now: float, monotonic: float
    ):
        self.store, self.settings = store, settings
        self.states = store.load(tags, now)
        self.grace_until = monotonic + settings.startup_grace_seconds
        self.inflight: int | None = None

    def observe(self, tag_id: str, now: float, rssi: int) -> None:
        state = self.states[tag_id]
        if state.last_seen is not None and now < state.last_seen:
            # A backward wall-clock step must not leave an impossible future last_seen.
            log.warning("Clock moved backwards for tag %s", tag_id)
        with self.store.db:
            if state.missing_since is not None:
                pending = self.store.db.execute(
                    "SELECT id FROM outbox WHERE tag_id=? AND episode=? AND kind='absence'",
                    (tag_id, state.episode),
                ).fetchone()
                needs_recovery = state.alert_sent or (
                    pending is not None and pending["id"] == self.inflight
                )
                if needs_recovery:
                    self.store.enqueue(
                        state,
                        "recovery",
                        f"✓ {state.name} is detected again.\n"
                        f"Absent for {duration(now - state.absence_start)}.\n"
                        f"RSSI: {rssi} dBm.",
                    )
                    log.info("Tag recovered: %s", tag_id)
                elif pending:
                    self.store.db.execute("DELETE FROM outbox WHERE id=?", (pending["id"],))
                state.episode += 1
            state.last_seen, state.last_rssi = now, rssi
            state.missing_since, state.alert_sent = None, False
            self.store.save(state)
        log.debug("Tag matched: %s RSSI=%s dBm", tag_id, rssi)

    def tick(self, now: float, monotonic: float) -> None:
        with self.store.db:
            for state in self.states.values():
                absent = now - state.absence_start
                if absent > self.settings.missing_after_seconds and state.missing_since is None:
                    state.missing_since = state.absence_start
                    log.info("Tag became missing: %s", state.tag_id)
                if (
                    monotonic >= self.grace_until
                    and absent > self.settings.alert_after_seconds
                    and not state.alert_sent
                ):
                    seen = (
                        datetime.fromtimestamp(state.last_seen, UTC).strftime(
                            "%Y-%m-%d %H:%M:%S UTC"
                        )
                        if state.last_seen is not None
                        else "never (timer starts at first service start)"
                    )
                    rssi = f"{state.last_rssi} dBm" if state.last_rssi is not None else "unknown"
                    self.store.enqueue(
                        state,
                        "absence",
                        f"⚠ {state.name} has not been detected for {duration(absent)}.\n"
                        f"Last seen: {seen}.\nLast RSSI: {rssi}.",
                    )
                self.store.save(state)

    def claim(self, now: float, monotonic: float) -> Notification | None:
        if monotonic < self.grace_until or self.inflight is not None:
            return None
        item = self.store.next_notification(now, list(self.states))
        if item:
            self.inflight = item.id
        return item

    def delivered(self, item: Notification) -> None:
        state = self.states[item.tag_id]
        with self.store.db:
            if item.kind == "absence" and state.episode == item.episode:
                state.alert_sent = True
                self.store.save(state)
            self.store.db.execute("DELETE FROM outbox WHERE id=?", (item.id,))
        self.inflight = None
        log.info("%s notification sent: %s", item.kind.capitalize(), item.tag_id)

    def failed(self, item: Notification, now: float, retry_after: float = 0) -> None:
        delay = max(retry_after, min(900, 30 * 2 ** min(item.attempts, 5)))
        with self.store.db:
            self.store.db.execute(
                "UPDATE outbox SET attempts=attempts+1,next_attempt=? WHERE id=?",
                (now + delay, item.id),
            )
        self.inflight = None
