from dataclasses import dataclass, field


@dataclass(frozen=True)
class Tag:
    id: str
    name: str
    pair_date: int
    eik: bytes = field(repr=False)
    clock_offset_seconds: int = 0


@dataclass
class State:
    tag_id: str
    name: str
    created_at: float
    last_seen: float | None = None
    last_rssi: int | None = None
    alert_sent: bool = False
    missing_since: float | None = None
    episode: int = 0

    @property
    def absence_start(self) -> float:
        return self.last_seen if self.last_seen is not None else self.created_at


@dataclass(frozen=True)
class Notification:
    id: int
    tag_id: str
    episode: int
    kind: str
    message: str
    attempts: int
