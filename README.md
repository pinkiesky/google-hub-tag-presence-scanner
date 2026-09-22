# Cat tracker

Node.js 24 / TypeScript / NestJS service for Raspberry Pi OS ARM64. One BLE scanner
identifies Google Find Hub tags cryptographically, records presence in SQLite,
exports Prometheus metrics, and serves a read-only LAN page at
`http://raspberrypi.local:15432/`. No external service requests are made.

## Build and test

```sh
npm ci
npm run build
npm test
npm run lint
npm run start:prod
```

Use Node.js 24 (check `node --version`). Building native npm modules with node-gyp requires Python 3,
`build-essential`, `libbluetooth-dev`, `libudev-dev`, `libusb-1.0-0-dev`, and
`pkg-config`. Python is only a native build prerequisite; the application and tests use Node.js. `package-lock.json` pins dependencies. The `allowScripts` entries in
`package.json` permit the native builds on recent npm versions. Build/install on
the Pi itself; do not copy x86 `node_modules` to ARM64. Production runs compiled
`node dist/main.js`, without ts-node. `npm run start:dev` watches TypeScript;
`npm run test:watch` watches tests. Templates/CSS are copied into `dist` on build.

Use `npm run format` to format the project with Prettier, or `npm run format:check`
to check formatting without changing files. Generated files and reference fixtures are excluded.

Tests use synthetic secrets, a SQLite fixture, mocked Bluetooth, and a real
localhost HTTP listener. No test requires real keys. A restricted sandbox must permit local sockets for HTTP tests.

## Configuration

Configuration is plain JSON, loaded from `/etc/cat-tracker/config.json` by default.
Use `--config PATH` or `TAG_CONFIG_PATH` to select another JSON file. Start with
[config.example.json](config.example.json) for service settings and tags, or
[tags.example.json](tags.example.json) for tags with default service settings.
Relative secret paths resolve against the configuration file. JSON may be
`{ "service": {...}, "tags": [...] }` or a tag array. Setting names remain snake_case,
and environment variables override service settings. Comments and trailing commas
are not valid JSON.

| Variable                | Default                                 |
| ----------------------- | --------------------------------------- |
| `TAG_CONFIG_PATH`       | `/etc/cat-tracker/config.json`          |
| `DATABASE_PATH`         | `/var/lib/cat-tracker/presence.sqlite3` |
| `BLUETOOTH_ADAPTER`     | `0` (`hci0` and `hci1` also accepted)   |
| `PORT`                  | `15432`                                 |
| `MISSING_AFTER_SECONDS` | `60`                                    |
| `DRIFT_WINDOWS`         | `16` (1–32)                             |
| `SCANNER_CYCLE_SECONDS` | `300`                                   |

`@nestjs/config` loads/validates settings. Foreground runs use exported environment variables; the systemd template uses
the JSON configuration. The application does not
silently load a working-directory `.env`. Keep EIKs in separate secret JSON files:
`version` (1), `name`, `pair_date` (integer Unix UTC seconds), `eik_hex` (64 hex
characters). Manufacturer/model metadata remains ignored. Invalid secrets disable
only that tag; no usable tags, duplicate IDs, or invalid global
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
sudoedit /etc/cat-tracker/config.json
sudo chmod 0750 /etc/cat-tracker
sudo systemctl start cat-tracker
sudo systemctl status cat-tracker --no-pager
sudo journalctl -u cat-tracker -f
sudo journalctl -u cat-tracker --since today
```

For updates use `deploy/update_remote user@host`, then `deploy/restart_remote
user@host`. Scripts are in-place deployments, not atomic releases. No local secret files or databases are copied by these scripts.

The unit preserves `/opt/cat-tracker`,
`/var/lib/cat-tracker`, the service user, private directory permissions, and restart
policy. It starts after Bluetooth/network/time-sync targets, restarts after 5
seconds, and uses Nest shutdown hooks on SIGTERM/SIGINT.

## Bluetooth access and diagnostics

Noble uses the Linux raw HCI backend with explicit `deviceId`. The unit grants **only `CAP_NET_RAW`** through systemd's
`AmbientCapabilities` and `CapabilityBoundingSet`, and permits `AF_BLUETOOTH` and
`AF_NETLINK`. The service does not run as root. No capability is added to the shared
Node binary. Raw mode requires the selected adapter to be powered on. `hci1` is
selected by `BLUETOOTH_ADAPTER=1` in the environment file.

Stop the normal service before debug scanning, then run a transient unit with the
same user/capability (this does not open SQLite or HTTP):

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

## State storage

SQLite stores tag identity, creation time, and last-seen timestamps. Keep the
database across restarts to preserve last-seen metrics. It uses WAL and FULL
synchronization. Back up a live database with SQLite's `.backup` command.
A file lock prevents two instances sharing one database. RSSI stays in memory;
no RSSI history or Prometheus counters are persisted.

Existing databases remain compatible without a destructive migration. Legacy
columns and tables are ignored and left untouched; new databases contain only
the presence state table.

## Tracking behavior

EIDs are derived using a
32-byte AES-256-ECB block, rotation every 1024 seconds, 32-bit clock wrap, scalar
reduction, secp160r1 / P-256 public x-coordinate. Clock is
`trunc(now - pair_date + clock_offset_seconds)`; each tag has ±16 cached windows by
default. Ambiguous EIDs are rejected. `@noble/curves` performs curve arithmetic and
`node:crypto` performs AES. Known EID vectors are checked by `npm test`.

Missing begins strictly **after 60 seconds** by default, using the configured
presence timeout. Presence is evaluated from last-seen on each page request and
is never RSSI-gated.

The page is rendered server-side from `views/index.pug`, compiled once at startup
and supplied with a fresh display model for each request. Pug escapes dynamic
values; no HTML strings are assembled in TypeScript. The build copies Pug templates
to `dist/views`, and `npm run format` includes Pug via `@prettier/plugin-pug`.

The human-readable page at `/` displays only cat name, Present / Not present, and
latest signal strength. Absent cats and cats without a signal observation since
startup show `—`. The existing `PresenceService` is the authoritative presence
state service; `getAllStatuses()` supplies the web layer. The page also serves
`/index.html`, HEAD, and CSS, with LAN-only IPv4 peer checks, no-store and CSP
headers. There is no status API, JavaScript, polling, or automatic refresh.
Public and IPv6 peers are rejected; forwarded headers are ignored.

## Prometheus metrics

Matched BLE packets flow through `TagMatcherService` → `TagObservationService`,
which directly updates `PresenceService` and `MetricsService`. `/metrics` reads
only a dedicated [prom-client](https://github.com/siimon/prom-client) registry and
returns its Prometheus text content type. The existing LAN access policy applies.
No default Node/process metrics are enabled.

| Metric                            | Type    | Value                                                      |
| --------------------------------- | ------- | ---------------------------------------------------------- |
| `cat_rssi_dbm`                    | Gauge   | Latest valid RSSI                                          |
| `cat_rssi_samples_total`          | Counter | One per valid RSSI sample                                  |
| `cat_rssi_offset_sum_total`       | Counter | Sum of RSSI + 120 for every valid sample                   |
| `cat_last_seen_timestamp_seconds` | Gauge   | Latest cryptographically matched observation, Unix seconds |

All labels use stable configured IDs (`tag="cat-a"`). Counters start at zero for
all configured tags and reset on process restart; Prometheus `increase()` handles
resets. Last-seen gauges initialize from persisted timestamps. Unknown last-seen
and RSSI gauge series are omitted until observed, rather than inventing values or
exporting non-finite samples. Zero counters ensure unobserved tags remain visible.
RSSI gauges retain their latest valid value; use last-seen to assess freshness.

RSSI must be finite and between -120 and +20 dBm inclusive. Values below -120
cannot contribute to the non-negative offset counter; invalid values (including
BLE's unavailable sentinel) are excluded from both RSSI counters and the gauge.
Cryptographic matches still update presence and last-seen regardless of RSSI.
No application-side average is calculated.

Example queries (documentation only):

```promql
# Average RSSI over five minutes; no samples gives an undefined result
increase(cat_rssi_offset_sum_total[5m])
/ increase(cat_rssi_samples_total[5m]) - 120

# Seconds since last observation (never-seen tags have no timestamp series)
time() - cat_last_seen_timestamp_seconds

# Not seen for more than one hour
time() - cat_last_seen_timestamp_seconds > 3600

# Tracker unavailable: up is generated by Prometheus, not this application
up{job="cat-tracker"} == 0
```

Alerting is owned by external Prometheus infrastructure. This application only
exports metrics; it does not schedule alerts or deliver notifications. No
production Prometheus/Alertmanager configuration or deployment was performed.

Reference APIs: [noble adapter/capability configuration](https://github.com/stoprocent/noble#multiple-adapters-linux-specific),
[noble custom curves](https://github.com/paulmillr/noble-curves#weierstrass-custom-weierstrass-curve--ecdsa).

The package override for `multer` keeps Nest 11's transitive dependency on the
patched 2.3.x-or-newer compatible release. This service exposes no upload routes.

## Bluetooth health metrics

The existing `/metrics` endpoint also exports three series labeled with the
configured adapter (`adapter="hci0"`, or e.g. `hci1`):

- `cat_bluetooth_adapter_up` (gauge): 1 when Noble reports `poweredOn`, otherwise 0.
- `cat_bluetooth_scanner_up` (gauge): 1 only after scanning starts successfully;
  stops, errors, adapter loss, and shutdown set it to 0.
- `cat_bluetooth_scanner_restarts_total` (counter): automatic scan-start attempts
  after unexpected failures. Initial startup and scheduled scan refreshes do not
  count. Waiting for an unavailable adapter does not count until scan start is
  attempted. The counter resets only with the process.

All three initialize to zero. Adapter and scanner gauges are independent: a
powered-on adapter can have a failed scanner. Prometheus `up == 0` indicates a
scrape/service/network problem; adapter down indicates an adapter/BlueZ issue;
adapter up with scanner down indicates a scanning issue. Both gauges up with a
stale tag timestamp suggests the tag is absent or out of range, but cannot prove
radio reception is working. The restart counter is not a health gauge.
