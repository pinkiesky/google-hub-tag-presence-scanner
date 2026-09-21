from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from cat_tracker import status_page
from cat_tracker.config import Settings
from cat_tracker.models import Tag
from cat_tracker.presence.manager import PresenceManager
from cat_tracker.storage.sqlite import Store


@pytest.mark.parametrize(
    "address,allowed",
    [
        ("127.0.0.1", True),
        ("192.168.0.123", True),
        ("10.1.2.3", True),
        ("172.16.0.1", True),
        ("172.31.255.254", True),
        ("169.254.1.2", True),
        ("172.32.0.1", False),
        ("8.8.8.8", False),
        ("100.64.0.1", False),
        ("0.0.0.0", False),
        ("::1", False),
        ("invalid", False),
    ],
)
def test_lan_clients(address, allowed):
    assert status_page.allowed_client(address) is allowed


def test_rolling_average_render_and_escaping(monkeypatch):
    store = Store(":memory:")
    tag = Tag("cat-a", "<script>alert(1)</script>", 0, bytes(32))
    manager = PresenceManager(store, [tag], Settings(), 1000, 0)
    assert manager.average_rssi(tag.id, 0) is None
    monkeypatch.setattr("cat_tracker.presence.manager.time.monotonic", lambda: 10)
    manager.observe(tag.id, 1010, -50)
    monkeypatch.setattr("cat_tracker.presence.manager.time.monotonic", lambda: 110)
    manager.observe(tag.id, 1110, -70)
    assert manager.average_rssi(tag.id, 120) == -60
    manager.states[tag.id].alert_sent = True
    page = status_page.render(manager, 1111, 120).decode()
    assert "-60.0 dBm" in page and "<td>Yes</td>" in page
    assert "&lt;script&gt;" in page and "<script>" not in page
    assert "1970-01-01 00:18:30" in page
    assert manager.average_rssi(tag.id, 310) == -70
    assert manager.average_rssi(tag.id, 410) is None
    assert "—" in status_page.render(manager, 1410, 410).decode()
    store.close()


def test_http_snapshot_routes_and_shutdown(monkeypatch):
    monkeypatch.setattr(status_page, "PORT", 0)  # ephemeral test port
    server = status_page.StatusServer(b"initial")
    url = f"http://127.0.0.1:{server.server_port}"
    try:
        with urlopen(url, timeout=3) as response:
            assert response.read() == b"initial"
            assert response.headers["Cache-Control"] == "no-store"
        server.publish(b"updated")
        with urlopen(url, timeout=3) as response:
            assert response.read() == b"updated"
        with urlopen(Request(url, method="HEAD"), timeout=3) as response:
            assert response.read() == b""
            assert response.headers["Content-Length"] == "7"
        for path in ("/../config.toml", "/etc/passwd", "/api"):
            with pytest.raises(HTTPError) as error:
                urlopen(url + path, timeout=3)
            assert error.value.code == 404
        assert not server.verify_request(None, ("8.8.8.8", 12345))
    finally:
        server.close()
    assert not server._thread.is_alive()
