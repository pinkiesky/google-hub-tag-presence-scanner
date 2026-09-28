# cat-presence-satellite-rpi

Small Node.js 24 / TypeScript BLE scanner for Raspberry Pi OS ARM64. Scans FEAA
advertisements with duplicates enabled and forwards unmodified service data and
RSSI to mother. Contains no tag secrets, matching logic, database, or NestJS.

```sh
npm ci
npm run build
npm test
npm run lint
MOTHER_URL=http://192.168.1.2:15432 SATELLITE_ID=pi-living-room npm start
```

Native dependency builds need Python 3, build-essential, libbluetooth-dev,
libudev-dev, libusb-1.0-0-dev and pkg-config. BlueZ must be running and the selected
adapter powered on. The deployment setup installs these prerequisites.

## Environment only

The application reads `process.env`. It loads no JSON, `.env`, secret files, or
configuration arguments.

| Variable                | Default  | Meaning                                                                                  |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `MOTHER_URL`            | required | HTTP(S) origin, e.g. `http://192.168.1.2:15432`; no credentials, path, query or fragment |
| `SATELLITE_ID`          | required | Stable ID, 1–64 letters, digits, underscores or hyphens                                  |
| `BLUETOOTH_ADAPTER`     | `0`      | Adapter number; `hci0`, `hci1` also accepted                                             |
| `SCANNER_CYCLE_SECONDS` | `300`    | Positive scan refresh interval in seconds                                                |

Choose unique IDs for distinct receivers. HTTP ingestion uses mother's existing
private IPv4 LAN policy without an authentication token.

## Deployment

Use `deploy/install_remote`, `deploy/setup_infra_remote`, `deploy/update_remote`,
and `deploy/restart_remote`, each accepting `user@host`; see the root README.
The service runs as `cat-presence-satellite-rpi` from
`/opt/cat-presence-satellite-rpi`, with `CAP_NET_RAW` granted by systemd only.
No application state/configuration directory is created. Configure it with:

```sh
sudo systemctl edit cat-presence-satellite-rpi
```

Enter:

```ini
[Service]
Environment=MOTHER_URL=http://192.168.1.2:15432
Environment=SATELLITE_ID=pi-living-room
Environment=BLUETOOTH_ADAPTER=0
Environment=SCANNER_CYCLE_SECONDS=300
```

Then run `sudo systemctl restart cat-presence-satellite-rpi` and inspect
`sudo journalctl -u cat-presence-satellite-rpi -f`. Updates preserve this override.

## Delivery and diagnostics

The scanner sends one JSON observation per `POST /api/v1/observations`. One request
is in flight at a time, with a two-second timeout. The memory queue holds at most
100 observations, dropping the oldest on overflow and anything queued longer than
two seconds. Failed requests are discarded and sending pauses for five seconds.
There is no disk backlog, retry, or historical replay. Scanning continues during
HTTP outages. Mother uses its receive time when matching and updating presence.

Scanner refresh/recovery retains 5/10/20/40-second backoff and exits after five
short failures; uncertain cleanup is fatal. Systemd restarts after five seconds.
SIGINT/SIGTERM cancel forwarding and stop scanning. Logs report radio transitions,
recovery, received/forwarded advertisements, and sent/dropped HTTP counts every
three minutes; no raw bytes or tag identifiers are logged.

For local diagnostics, stop the satellite service first and run `npm run debug`
in an environment with the same four settings and Bluetooth permissions. It
prints reception/RSSI/byte counts without forwarding HTTP or identifying tags.
For an installed service, a temporary override retains its environment and
capabilities:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/node /opt/cat-presence-satellite-rpi/dist/debug.js
```

Restart and inspect the journal, then remove only these temporary `ExecStart`
lines and restart to restore normal forwarding. Do not remove the environment
settings. An idle radio cannot distinguish absent tags from reception problems.
