from cat_tracker.config import Settings
from cat_tracker.models import Tag
from cat_tracker.presence.manager import PresenceManager
from cat_tracker.storage.sqlite import Store

TAGS = [Tag("a", "Cat A", 0, bytes(32)), Tag("b", "Cat B", 0, bytes([1]) * 32)]


def manager(path=":memory:", now=0, mono=0, grace=120):
    store = Store(str(path))
    return PresenceManager(store, TAGS, Settings(startup_grace_seconds=grace), now, mono)


def test_threshold_independence_and_repeated_cycle():
    m = manager()
    m.observe("a", 0, -70)
    m.observe("b", 0, -80)
    m.tick(61, 61)
    assert m.states["a"].missing_since == 0
    m.tick(3600, 3600)
    assert m.claim(3600, 3600) is None
    m.observe("b", 3601, -90)  # RSSI never gates presence
    m.tick(3601, 3601)
    alert = m.claim(3601, 3601)
    assert alert.tag_id == "a" and alert.kind == "absence"
    assert not m.states["a"].alert_sent
    m.delivered(alert)
    assert m.states["a"].alert_sent
    m.tick(3610, 3610)
    assert m.claim(3610, 3610) is None
    m.observe("a", 4000, -57)
    recovery = m.claim(4000, 4000)
    assert recovery.kind == "recovery"
    assert "1 h 6 min" in recovery.message
    m.delivered(recovery)
    m.observe("a", 4001, -58)
    assert m.claim(4001, 4001) is None
    m.observe("b", 7602, -80)
    m.tick(7602, 7602)
    assert m.claim(7602, 7602).kind == "absence"
    m.store.close()


def test_restart_grace_and_never_seen(tmp_path):
    path = tmp_path / "state.sqlite3"
    m = manager(path)
    m.observe("a", 100, -63)
    m.store.close()
    m = manager(path, now=3100, mono=0)
    assert m.states["a"].last_seen == 100
    assert m.states["b"].created_at == 0
    m.tick(4000, 119)
    assert m.claim(4000, 119) is None
    m.tick(4001, 120)
    alert = m.claim(4001, 120)
    assert alert.tag_id == "a"
    m.delivered(alert)
    m.store.close()
    m = manager(path, now=4100, mono=0, grace=0)
    assert m.states["a"].alert_sent
    assert m.claim(4100, 1).tag_id == "b"
    m.store.close()


def test_failed_alert_and_recovery_retries(tmp_path):
    m = manager(tmp_path / "state.db", grace=0)
    m.tick(3601, 3601)
    item = m.claim(3601, 3601)
    m.failed(item, 3601)
    assert not m.states["a"].alert_sent
    other = m.claim(3602, 3602)
    assert other.tag_id == "b"
    m.delivered(other)
    assert m.claim(3630, 3630) is None
    item = m.claim(3631, 3631)
    m.delivered(item)
    m.observe("a", 4000, -50)
    recovery = m.claim(4000, 4000)
    m.failed(recovery, 4000)
    m.observe("a", 4001, -51)
    m.store.close()
    m = manager(tmp_path / "state.db", now=4010, grace=0)
    recovery2 = m.claim(4030, 4030)
    assert recovery.id == recovery2.id
    m.delivered(recovery2)
    assert m.claim(4031, 4031) is None
    m.store.close()


def test_observation_during_delivery_cannot_alert_new_episode():
    m = manager(grace=0)
    m.observe("b", 3601, -70)
    m.tick(3601, 3601)
    alert = m.claim(3601, 3601)
    m.observe("a", 3602, -60)  # callback during Telegram await
    m.delivered(alert)
    assert not m.states["a"].alert_sent
    recovery = m.claim(3602, 3602)
    assert recovery.kind == "recovery"
    m.delivered(recovery)
    assert m.claim(3603, 3603) is None
    m.store.close()


def test_unsent_alert_cancelled_when_tag_returns():
    m = manager(grace=0)
    m.observe("b", 3601, -70)
    m.tick(3601, 3601)
    m.observe("a", 3602, -60)
    assert m.claim(3602, 3602) is None
    m.store.close()


def test_inflight_failure_then_restart_preserves_order(tmp_path):
    path = tmp_path / "state.db"
    m = manager(path, grace=0)
    m.observe("b", 3601, -70)
    m.tick(3601, 3601)
    item = m.claim(3601, 3601)
    m.observe("a", 3602, -60)
    m.failed(item, 3603)
    assert m.claim(3604, 3604) is None  # recovery must wait for absence delivery
    m.store.close()
    m = manager(path, now=3610, grace=0)
    item = m.claim(3633, 3633)
    assert item.kind == "absence"
    m.delivered(item)
    assert not m.states["a"].alert_sent
    item = m.claim(3634, 3634)
    assert item.kind == "recovery"
    m.delivered(item)
    assert m.claim(3635, 3635) is None
    m.store.close()
