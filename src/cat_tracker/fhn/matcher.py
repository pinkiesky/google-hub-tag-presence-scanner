from ..models import Tag
from .eid import ROTATION_SECONDS, calculate_eid


class Matcher:
    def __init__(self, tags: list[Tag], drift_windows: int = 16):
        self.tags = tags
        self.drift_windows = drift_windows
        self._windows: tuple[int, ...] = ()
        self._cache: dict[bytes, str | None] = {}

    def refresh(self, now: float) -> None:
        windows = tuple(
            int(now - t.pair_date + t.clock_offset_seconds) // ROTATION_SECONDS for t in self.tags
        )
        if windows == self._windows:
            return
        cache: dict[bytes, str | None] = {}
        for tag, window in zip(self.tags, windows):
            for delta in range(-self.drift_windows, self.drift_windows + 1):
                for size in (20, 32):
                    eid = calculate_eid(tag.eik, (window + delta) * ROTATION_SECONDS, size)
                    cache[eid] = tag.id if eid not in cache else None  # reject ambiguity
        self._cache, self._windows = cache, windows

    def match(self, eid: bytes) -> str | None:
        return self._cache.get(eid)
