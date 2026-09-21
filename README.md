# Cat tracker

Node.js 24 / TypeScript / NestJS service for Raspberry Pi OS ARM64. One BLE scanner
identifies Google Find Hub tags cryptographically, records presence in SQLite,
sends Telegram absence/recovery notifications, and serves a read-only LAN page at
`http://raspberrypi.local:15432/`. Internet is needed only for Telegram.

## Build and test

```sh
npm ci
npm run build
npm test
npm run lint
npm run start:prod
```

Use Node.js 24 (check `node --version`). Native modules require Python 3,
`build-essential`, `libbluetooth-dev`, `libudev-dev`, `libusb-1.0-0-dev`, and
`pkg-config`. `package-lock.json` pins dependencies. The `allowScripts` entries in
`package.json` permit the native builds on recent npm versions. Build/install on
the Pi itself; do not copy x86 `node_modules` to ARM64. Production runs compiled
`node dist/main.js`, without ts-node. `npm run start:dev` watches TypeScript;
`npm run test:watch` watches tests. Templates/CSS are copied into `dist` on build.

Tests use synthetic secrets, a Python-generated SQLite dump, mocked Bluetooth and
Telegram, and a real localhost HTTP listener. No test requires real keys or sends
Telegram messages. A restricted sandbox must permit local sockets for HTTP tests.

## Configuration

Existing `/etc/cat-tracker/config.toml` works unchanged. `--config PATH` selects a
different file. Alternatively set `TAG_CONFIG_PATH` to a TOML file or JSON file
like `tags.example.json`. Relative secret paths resolve against the config file.
JSON may be `{ "tags": [...] }` or a tag array; a `service` object accepts the same
snake_case fields as TOML. Environment variables override service settings.

| Variable | Default |
| --- | --- |
| `TAG_CONFIG_PATH` | `/etc/cat-tracker/config.toml` |
| `DATABASE_PATH` | `/var/lib/cat-tracker/presence.sqlite3` |
| `BLUETOOTH_ADAPTER` | `0` (`hci0` and `hci1` also accepted) |
| `PORT` | `15432` |
| `ALERT_AFTER_SECONDS` | `3600` |
| `MISSING_AFTER_SECONDS` | `60` |
| `STARTUP_GRACE_SECONDS` | `120` |
| `WATCHDOG_INTERVAL_SECONDS` | `30` |
| `DRIFT_WINDOWS` | `16` (1–32) |
| `SCANNER_CYCLE_SECONDS` | `300` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | required, except `--debug-scan` |

`@nestjs/config` loads/validates settings. Environment files are loaded by systemd;
foreground runs use exported environment variables. The application does not
silently load a working-directory `.env`. Keep EIKs in separate secret JSON files:
`version` (1), `name`, `pair_date` (integer Unix UTC seconds), `eik_hex` (64 hex
characters). Manufacturer/model metadata remains ignored. Invalid secrets disable
only that tag, as Python did; no usable tags, duplicate IDs, or invalid global
settings fail startup. Secret contents and paths are never logged or rendered.
Keep IDs stable: changing an ID starts a new presence timer.

## Raspberry Pi installation

Use Raspberry Pi OS 64-bit on Pi 4, with Node.js 24 LTS installed at `/usr/bin/node`
and npm available to sudo. The setup script checks this; it does not replace the
OS runtime. If Node lives elsewhere, adjust the unit's `ExecStart` accordingly.

```sh
sudo apt update
sudo apt install -y python3 build-essential bluez libbluetooth-dev libudev-dev \
  libusb-1.0-0-dev pkg-config libcap2-bin sqlite3 rsync
sudo systemctl enable --now bluetooth
sudo bluetoothctl power on
```

From this checkout, the existing remote scripts retain their interface. They
require local/remote rsync, SSH, and noninteractive sudo on the Pi:

```sh
./deploy/install_remote rglr@192.168.0.123
./deploy/setup_infra_remote rglr@192.168.0.123
```

Setup creates the existing `cat-tracker` service user, private state directory,
config templates only if missing, installs dependencies, builds/tests, and
installs/enables the unit. It does not start the tracker. Install secrets and edit
configuration on the Pi before starting:

```sh
sudo install -o root -g cat-tracker -m 0640 /path/to/cat-a.json /etc/cat-tracker/cat-a.json
sudo install -o root -g cat-tracker -m 0640 /path/to/cat-b.json /etc/cat-tracker/cat-b.json
sudoedit /etc/cat-tracker/config.toml
sudoedit /etc/cat-tracker/telegram.env
sudo chmod 0750 /etc/cat-tracker
sudo chmod 0600 /etc/cat-tracker/telegram.env
sudo systemctl start cat-tracker
sudo systemctl status cat-tracker --no-pager
sudo journalctl -u cat-tracker -f
sudo journalctl -u cat-tracker --since today
```

For updates use `deploy/update_remote user@host`, then `deploy/restart_remote
user@host`. Scripts are in-place deployments, not atomic releases. Use the backup
and rollback procedure below for the first migration. Existing Python source and
venv are retained. No local secret files or databases are copied by these scripts.

The unit preserves `/opt/cat-tracker`, `/etc/cat-tracker/telegram.env`,
`/var/lib/cat-tracker`, the service user, private directory permissions, and restart
policy. It starts after Bluetooth/network/time-sync targets, restarts after 5
seconds, and uses Nest shutdown hooks on SIGTERM/SIGINT.

## Bluetooth access and diagnostics

Noble uses the Linux raw HCI backend with explicit `deviceId`, unlike Python's
BlueZ D-Bus backend. The unit grants **only `CAP_NET_RAW`** through systemd's
`AmbientCapabilities` and `CapabilityBoundingSet`, and permits `AF_BLUETOOTH` and
`AF_NETLINK`. The service does not run as root. No capability is added to the shared
Node binary. The old D-Bus policy may remain for Python rollback but is unnecessary
for Node. Raw mode requires the selected adapter to be powered on. `hci1` is
selected by `BLUETOOTH_ADAPTER=1` in the environment file.

Stop the normal service before debug scanning, then run a transient unit with the
same user/capability (this does not open SQLite, HTTP, or Telegram):

```sh
sudo systemctl stop cat-tracker
sudo systemd-run --unit=cat-tracker-debug --collect --wait --pty \
  --property=User=cat-tracker --property=Group=cat-tracker \
  --property=AmbientCapabilities=CAP_NET_RAW \
  --property=CapabilityBoundingSet=CAP_NET_RAW \
  /usr/bin/node /opt/cat-tracker/dist/main.js --debug-scan
# Ctrl-C ends the scan. Restore the service afterwards:
sudo systemctl start cat-tracker
```

Debug output reports matched IDs and RSSI. Normal logs summarize counts every 30
seconds; `--debug` enables individual matched observations. Neither raw packets
nor EIKs are logged. Scanning has no advertised UUID filter and allows duplicates;
FEAA may exist only in service data. Noble is configured to report advertisements
without waiting for scan responses. Extended advertisements are auto-detected by
noble; 32-byte EID reception requires a capable adapter. Parser/crypto support both
20- and 32-byte EIDs regardless of radio support.

The scanner cycles every five minutes, retries short failures after 5/10/20/40
seconds, and exits after five failures. Failed cleanup is fatal, avoiding
concurrent scanner ownership. A radio returning no packets cannot always be
distinguished from absent tags; check scan summaries, rfkill, `bluetoothctl show`,
and adapter permissions. Missing means not detected, not proof that a cat left.

## Migrating from Python and preserving SQLite

1. Run the tests and retain the original installation for rollback. Python remains
   in `src/cat_tracker`, its tests in `tests`, and its instructions in
   [docs/PYTHON.md](docs/PYTHON.md). `deploy/cat-tracker-python.service` retains the
   original unit. Do not delete these before hardware acceptance.
2. Back up before updating the unit. On the Pi:

   ```sh
   sudo install -d -m 0700 /var/backups/cat-tracker
   sudo cp /etc/systemd/system/cat-tracker.service /var/backups/cat-tracker/python-before-node.service
   sudo tar -C /opt -czf /var/backups/cat-tracker/python-before-node.tar.gz cat-tracker
   sudo sqlite3 /var/lib/cat-tracker/presence.sqlite3 \
     ".backup '/var/backups/cat-tracker/presence-before-node.sqlite3'"
   ```

   Adapt the database path if your config differs. The online SQLite backup
   includes committed WAL data; do not copy a live database without its WAL.
3. Install/build/test Node using the scripts above. Preserve the config file,
   secret files, environment file, IDs, and database path.
4. Stop Python, start Node, and inspect the page/logs:

   ```sh
   sudo systemctl stop cat-tracker
   sudo systemctl daemon-reload
   sudo systemctl start cat-tracker
   sudo journalctl -u cat-tracker -n 60 --no-pager
   curl http://127.0.0.1:15432/
   ```

   Never run two scanners simultaneously. Both implementations acquire the same
   `DATABASE_PATH.lock` flock, protecting state/outbox ownership as well.
5. Confirm both real IDs and RSSI in logs, fresh page values after browser refresh,
   grace period, one disappearance/recovery cycle, and restart continuity. Allow
   more than one hour plus one watchdog interval for the default alert test.
   For a supervised shorter test change `ALERT_AFTER_SECONDS` and
   `MISSING_AFTER_SECONDS` together, then restore defaults. Do not manufacture
   absence by editing the production database.

No schema conversion is needed: `states`, `outbox`, Unix-second timestamps,
`created_at`, `episode`, retries, and unique constraints are preserved. SQLite
uses WAL and FULL synchronization. Loading does not reset timers or confirmations.
Disabled tags' pending messages remain stored and are not delivered until their
IDs are enabled again. Only matched observations update state; raw packets are
not stored. RSSI samples remain in memory for five minutes and reset on restart.

Rollback without discarding observations recorded by Node:

```sh
sudo systemctl stop cat-tracker
sudo cp /var/backups/cat-tracker/python-before-node.service /etc/systemd/system/cat-tracker.service
sudo systemctl daemon-reload
sudo systemctl start cat-tracker
```

The retained Python venv can read the same database, including new Node state and
outbox entries. Do not restore the old database unless deliberately rolling back
presence history too. The installation archive is available if source recovery
is needed.

## Behavior and parity

The EID algorithm is ported from Python, not reconstructed from protocol prose:
32-byte AES-256-ECB block, rotation every 1024 seconds, 32-bit clock wrap, scalar
reduction, secp160r1 / P-256 public x-coordinate. Clock is
`trunc(now - pair_date + clock_offset_seconds)`; each tag has ±16 cached windows by
default. Ambiguous EIDs are rejected. `@noble/curves` performs curve arithmetic and
`node:crypto` performs AES. Regenerate the synthetic reference fixtures with:

```sh
.venv/bin/python scripts/generate-vectors.py
.venv/bin/pytest
npm test
```

Missing begins strictly **after 60 seconds**, and an alert is queued strictly
**after 3600 seconds**, preserving Python's boundary behavior. Both monotonic
startup grace and watchdog cadence are retained. Presence is never RSSI-gated.
The durable outbox preserves per-tag order; a failed tag does not block another.
Delivery requires HTTP success and Telegram `ok: true`. Retries start at 30 seconds
and cap at 15 minutes, honoring valid Telegram `retry_after`. Unsent stale absence
messages are canceled on return; a return during an in-flight send queues recovery
behind that send. Episode numbers protect new state from late acknowledgments.
Recovery confirmation is durable even though current state resets on observation,
as in Python. Lost Telegram responses can still cause duplicate external delivery;
Telegram has no sendMessage idempotency key.

The page preserves Python's table/CSS, `Never seen` / `Present` / `Missing` labels,
and separate `Alert sent` column. It serves `/`, `/index.html`, HEAD, and CSS, with
LAN-only IPv4 peer checks, no-store and CSP headers. There is no status API,
browser JavaScript, polling, automatic refresh, or frontend framework. Public and
IPv6 peers are rejected; forwarded headers are ignored.

Intentional differences: HTML is rendered from current memory per request rather
than publishing 30-second snapshots (requested); CSS is a static file; port is
configurable with its old default; forbidden peers receive HTTP 403 rather than
an immediate socket close; native HCI replaces D-Bus; HTTP uses fetch's bounded
20-second total timeout rather than httpx's additional connect/read timeouts.
Nest shutdown protects against noble's immediate SIGINT exit behavior.

Reference APIs: [noble adapter/capability configuration](https://github.com/stoprocent/noble#multiple-adapters-linux-specific),
[noble custom curves](https://github.com/paulmillr/noble-curves#weierstrass-custom-weierstrass-curve--ecdsa).

## Commissioning tools

Run these on the Pi as `cat-tracker` after building. `compare-python.cjs` uses the
retained Python venv and reports only aggregate results; keys never leave the Pi.

```sh
sudo -u cat-tracker node /opt/cat-tracker/scripts/compare-python.cjs /opt/cat-tracker/.venv/bin/python
```

For a real advertisement comparison, stop the normal service, run
`capture-python.py OUTPUT 30` with the Python venv as `cat-tracker`, then run
`node scripts/replay-advertisements.cjs OUTPUT` from `/opt/cat-tracker` with the
same permissions. Restart the normal service even if the check fails. The capture
contains rotating EIDs, timestamps and RSSI, never EIKs; keep it private. The replay
checks EID identity at the original capture time. Native advertisement extraction
is separately validated by the running Node scanner.

`telegram-probe.cjs` is an **opt-in live test**: it sends two clearly labeled
synthetic absence/recovery messages to the configured Telegram chat. It uses an
in-memory database and does not alter real tag state or scan BLE. Run only when
test messages are wanted:

```sh
sudo systemd-run --unit=cat-tracker-telegram-probe --collect --wait --pipe \
  --property=User=cat-tracker --property=Group=cat-tracker \
  --property=EnvironmentFile=/etc/cat-tracker/telegram.env \
  /usr/bin/node /opt/cat-tracker/scripts/telegram-probe.cjs
```

The package override for `multer` keeps Nest 11's transitive dependency on the
patched 2.3.x-or-newer compatible release. This service exposes no upload routes.
