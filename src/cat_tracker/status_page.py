"""Read-only LAN status page. HTTP never touches presence state or SQLite."""

import asyncio
import logging
import threading
import time
from datetime import UTC, datetime
from html import escape
from http.server import BaseHTTPRequestHandler, HTTPServer
from ipaddress import IPv4Address, IPv4Network

from .presence.manager import PresenceManager

PORT = 15432
LAN_NETWORKS = tuple(
    IPv4Network(n)
    for n in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
    )
)
log = logging.getLogger(__name__)


def allowed_client(address: str) -> bool:
    try:
        ip = IPv4Address(address)
    except ValueError:
        return False
    return any(ip in network for network in LAN_NETWORKS)


def render(manager: PresenceManager, now: float, monotonic: float) -> bytes:
    rows = []
    for state in manager.states.values():
        seen = (
            datetime.fromtimestamp(state.last_seen, UTC).strftime("%Y-%m-%d %H:%M:%S")
            if state.last_seen is not None
            else "Never"
        )
        average = manager.average_rssi(state.tag_id, monotonic)
        signal = "—" if average is None else f"{average:.1f} dBm"
        status = (
            "Never seen"
            if state.last_seen is None
            else "Missing"
            if now - state.last_seen > manager.settings.missing_after_seconds
            else "Present"
        )
        rows.append(
            f"<tr><th scope='row'>{escape(state.name)}<small>{escape(state.tag_id)}</small></th>"
            f"<td>{status}</td><td>{seen}</td><td>{signal}</td>"
            f"<td>{'Yes' if state.alert_sent else 'No'}</td></tr>"
        )
    generated = datetime.fromtimestamp(now, UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        "<title>Cat tracker</title><style>"
        "body{font:16px system-ui,sans-serif;margin:2rem auto;padding:0 1rem;max-width:1000px;"
        "color:#182b36;background:#f6f8fa}table{width:100%;border-collapse:collapse;background:white}"
        "th,td{text-align:left;padding:1rem;border-bottom:1px solid #dce3e8}"
        "small{display:block;color:#596975}p{color:#596975}.table{overflow-x:auto}"
        "</style></head><body><h1>Cat tracker</h1>"
        f"<p>Generated at {generated}. Refresh this page for updated data.</p>"
        "<div class='table'><table><thead><tr><th>Tag</th><th>Status</th><th>Last seen (UTC)</th>"
        "<th>Average RSSI · 5 min</th><th>Alert sent</th></tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table></div>"
        "<p>Updated every 30 seconds. RSSI averages use observations since service startup, "
        "up to five minutes. — means no recent observations. Alert sent means Telegram "
        "confirmed the absence notification for the current episode.</p></body></html>"
    ).encode()


class StatusServer(HTTPServer):
    allow_reuse_address = True

    def __init__(self, page: bytes):
        self._page = page
        self._lock = threading.Lock()
        super().__init__(("0.0.0.0", PORT), StatusHandler)
        self._thread = threading.Thread(target=self.serve_forever, name="status-http", daemon=True)
        self._thread.start()

    def verify_request(self, request, client_address) -> bool:
        return allowed_client(client_address[0])

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(3)
        return connection, address

    def publish(self, page: bytes) -> None:
        with self._lock:
            self._page = page

    def snapshot(self) -> bytes:
        with self._lock:
            return self._page

    def close(self) -> None:
        self.shutdown()
        self.server_close()
        self._thread.join(timeout=5)


class StatusHandler(BaseHTTPRequestHandler):
    server: StatusServer

    def do_GET(self) -> None:
        self._respond(body=True)

    def do_HEAD(self) -> None:
        self._respond(body=False)

    def _respond(self, *, body: bool) -> None:
        if self.path not in ("/", "/index.html"):
            self.send_error(404)
            return
        page = self.server.snapshot()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        )
        self.end_headers()
        if body:
            self.wfile.write(page)

    def log_message(self, format: str, *args) -> None:
        # Do not log arbitrary URLs/headers supplied by clients.
        pass


async def serve_status(manager: PresenceManager) -> None:
    server = StatusServer(render(manager, time.time(), time.monotonic()))
    log.info("LAN status page listening on IPv4 port %d", PORT)
    try:
        while True:
            if not server._thread.is_alive():
                raise RuntimeError("Status HTTP server stopped unexpectedly")
            server.publish(render(manager, time.time(), time.monotonic()))
            await asyncio.sleep(30)
    finally:
        await asyncio.to_thread(server.close)
