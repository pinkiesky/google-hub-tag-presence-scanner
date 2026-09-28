# cat-presence-mother

Node.js 24 / TypeScript / NestJS aggregator. Receives raw BLE observations from
RPi satellites over HTTP and existing CatTag satellites over UDP, identifies tags
cryptographically, records presence in SQLite, exports Prometheus metrics and
serves a read-only LAN page at port 15432. No Bluetooth adapter is required.

## Build and test

```sh
npm ci
npm run build
npm test
npm run lint
npm run start:prod
```

Use Node.js 24. Native SQLite and file-lock modules require Python 3 and
`build-essential`. Install/build on the target architecture. Production runs
compiled JavaScript; Pug templates and CSS are copied into `dist` on build.
The package has its own lockfile and does not depend on the satellite package.

Use `npm run format` to format the project with Prettier, or `npm run format:check`
to check formatting without changing files. Generated files and reference fixtures are excluded.

Tests use synthetic secrets, a SQLite fixture, and a real
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
| `PORT`                  | `15432`                                 |
| `UDP_PORT`              | `15433`                                 |
| `MISSING_AFTER_SECONDS` | `60`                                    |
| `DRIFT_WINDOWS`         | `16` (1–32)                             |

`@nestjs/config` loads/validates settings. Foreground runs use exported environment variables; the systemd template uses
the JSON configuration. The application does not
silently load a working-directory `.env`. Keep EIKs in separate secret JSON files:
`version` (1), `name`, `pair_date` (integer Unix UTC seconds), `eik_hex` (64 hex
characters). Manufacturer/model metadata remains ignored. Invalid secrets disable
only that tag; no usable tags, duplicate IDs, or invalid global
settings fail startup. Secret contents and paths are never logged or rendered.
Keep IDs stable: changing an ID starts a new presence timer.

## HTTP satellite input

`POST /api/v1/observations` accepts one JSON observation:

```json
{
  "satelliteId": "pi-living-room",
  "serviceUuid": "feaa",
  "serviceDataHex": "400000000000000000000000000000000000000000",
  "rssi": -63
}
```

The ID must contain 1–64 letters, digits, underscores or hyphens. UUID accepts
FEAA in short or canonical Bluetooth form (case insensitive). Hex must encode
1–255 bytes; RSSI must be a finite JSON number. Malformed input returns 400 and
bodies exceeding 4 KiB return 413. Valid input returns 204, even when its service
data is unsupported or does not match a configured tag. Only matching data updates
presence, using mother's receive time and source `satellite-rpi:<id>`. Invalid
signal strength does not gate a match; it is excluded from RSSI metrics.

The existing private-IPv4/LAN socket-peer policy applies to this API; forwarded
headers are ignored and no token is required. RPi transport is live-only: outages
lose observations rather than replaying historical presence. Only mother stores
secret files, derives EIDs and identifies tags. UDP sources retain their existing
`satellite:<id>` naming.

## UDP satellite input

The service listens on UDP port `15433` on all IPv4 interfaces. Set `UDP_PORT` or
`service.udp_port` to change it. It parses CatTag satellite frame version 5:

| Offset | Size     | Field                                 |
| ------ | -------- | ------------------------------------- |
| 0      | 1        | Magic (`CA`)                          |
| 1      | 1        | Version (`5`)                         |
| 2      | 2        | Satellite ID (big endian)             |
| 4      | 8        | Boot ID (big endian)                  |
| 12     | 8        | Sequence (big endian, starts at zero) |
| 20     | 2        | Service UUID (`FE AA`)                |
| 22     | 6        | Address bytes as sent                 |
| 28     | 1        | RSSI (signed int8, dBm)               |
| 29     | 1        | Service-data length                   |
| 30     | Variable | Unmodified service-data bytes         |

The declared length must match the datagram exactly. Valid frames produce a log line
with the sender, satellite ID, boot ID, sequence, address, RSSI, and up to 64 service-data bytes in hex.
Invalid frames produce a warning. Valid Find Hub service data is decoded to an EID
and passed to `TagMatcherService.observe`. A cryptographic match updates presence
and the last-seen metric using the server's receive time.

Sequence numbers must strictly increase for each satellite ID and boot ID pair.
Duplicates and older packets are ignored; gaps are allowed. The first received
sequence may be any value, including zero. A new boot ID starts a new sequence
stream. Sequence tracking is in memory and resets when the server restarts.

Matched observations use `sourceName`: `satellite:<id>` for UDP or
`satellite-rpi:<id>` for HTTP. Each source is saved with its last-seen time
and shown on the presence page, including after it becomes absent. RSSI is decoded from a signed
two's-complement byte and uses the same signal validation and metrics as HTTP
observations. Invalid RSSI still allows a matched packet to update presence.

To send a sample frame locally (presence updates require a configured tag's EID):

```sh
node - <<'JS'
const data = Buffer.concat([Buffer.from([0x40]), Buffer.alloc(20)]);
const frame = Buffer.alloc(30 + data.length);
frame[0] = 0xca;
frame[1] = 5;
frame.writeUInt16BE(1, 2);
frame.writeBigUInt64BE(1n, 4);
frame.writeBigUInt64BE(0n, 12);
frame.writeUInt16BE(0xfeaa, 20);
Buffer.from([1, 2, 3, 4, 5, 6]).copy(frame, 22);
frame.writeInt8(-63, 28);
frame[29] = data.length;
data.copy(frame, 30);
const socket = require('node:dgram').createSocket('udp4');
socket.send(frame, 15433, '127.0.0.1', () => socket.close());
JS
```

Watch the service log with `sudo journalctl -u cat-presence-mother -f`.
HTTP and UDP start together; neither requires Bluetooth.

## Installation and migration

Use this package's `deploy/install_remote`, `deploy/setup_infra_remote`,
`deploy/update_remote` and `deploy/restart_remote`, each taking `user@host`.
Setup checks Node.js 24 at `/usr/bin/node`, installs native build prerequisites,
creates the `cat-presence-mother` user and installs/enables its systemd unit. It
does not start the service. Application code lives at `/opt/cat-presence-mother`.
No Bluetooth software or capabilities are required by mother.

Configuration and state defaults remain `/etc/cat-tracker/config.json` and
`/var/lib/cat-tracker/presence.sqlite3`. Setup creates a configuration template
only when missing. Install tag secret files readable by `cat-presence-mother`
(mode 0640, root owner and service group), then start the service. Existing files
may require ownership changes; follow the [migration instructions](../README.md).
Do not copy development configuration or secret files into deployment sources.

## State storage

SQLite stores tag identity, creation time, aggregate last-seen time, and the
latest observation source in `states`. The `source_states` table keeps each
tag/source pair's last-seen time. `presence_samples` stores valid RSSI values
(and null for invalid RSSI) for the rolling presence window. Old samples are
pruned as observations arrive; queries filter by the current window as well.
The configured `MISSING_AFTER_SECONDS` value defines that window.

`sourceName` is required for every observation and stored state. Unobserved
tags and older rows without a source use `unknown`. Migration fills missing
sources and creates a source state for a legacy row with a known source. Legacy
rows have no recoverable RSSI samples, so their signal remains unknown until a
new observation arrives. Existing databases remain compatible; unrelated
legacy columns and tables are left untouched. Keep the database across restarts
to preserve presence and the current signal window. It uses WAL and FULL
synchronization. Back up a live database with SQLite's `.backup` command.
A file lock prevents two instances sharing one database. Prometheus counters
are not persisted.

## Tracking behavior

EIDs are derived using a
32-byte AES-256-ECB block, rotation every 1024 seconds, 32-bit clock wrap, scalar
reduction, secp160r1 / P-256 public x-coordinate. Clock is
`trunc(now - pair_date + clock_offset_seconds)`; each tag has ±16 cached windows by
default. Ambiguous EIDs are rejected. `@noble/curves` performs curve arithmetic and
`node:crypto` performs AES. Known EID vectors are checked by `npm test`.

Missing begins strictly **after 60 seconds** by default, using the configured
presence timeout. Presence is evaluated from last-seen on each status API request
and is never RSSI-gated. Aggregate presence is true when any source has been
seen within the window. Its signal is the highest valid RSSI across all sources
in that window. Each source has its own presence status and average of valid
RSSI samples in the same window. Sources remain listed after they become absent,
with a null average.

The single page at `/` is served from `views/realtime.pug`. Its small
JavaScript file fetches `GET /api/tags` on load and every second. The endpoint
returns `{ "tags": [...] }` with each configured tag's `id`, `name`,
`present`, `maxSignalDbm` (number or null), and `sources`. Each source has
`name`, `present`, and `averageSignalDbm` (number or null). The page shows
the aggregate state and a table of sources for each tag. It displays a retry
message if an update fails. Tag and source text is inserted with `textContent`.

The page, API, JavaScript, and CSS use the LAN-only IPv4 socket-peer policy,
no-store and CSP headers. Public and IPv6 peers are rejected; forwarded headers
are ignored. The build copies the Pug template and public assets to `dist`.
The separate HTTP observation API accepts satellite input.

## Prometheus metrics

Matched HTTP and satellite UDP packets flow through `TagMatcherService` → `TagObservationService`,
which directly updates `PresenceService` and `MetricsService`. `/metrics` reads
only a dedicated [prom-client](https://github.com/siimon/prom-client) registry and
returns its Prometheus text content type. The existing LAN access policy applies.
No default Node/process metrics are enabled.

| Metric                                   | Type  | Labels          | Value                                                      |
| ---------------------------------------- | ----- | --------------- | ---------------------------------------------------------- |
| `cat_rssi_dbm`                           | Gauge | `tag`, `source` | Latest valid RSSI                                          |
| `cat_last_seen_timestamp_seconds`        | Gauge | `tag`           | Latest cryptographically matched observation, Unix seconds |
| `cat_source_last_seen_timestamp_seconds` | Gauge | `tag`, `source` | Latest matched observation from that source, Unix seconds  |

All labels use stable configured IDs (`tag="cat-a"`). `source` is the observation's
`sourceName` (`satellite-rpi:<id>` or `satellite:<id>`). RSSI is split by source
because signal strength from different receivers is not comparable. Last-seen gauges
initialize from persisted timestamps for every known source. Unknown last-seen and RSSI gauge
series are omitted until observed, rather than inventing values or exporting
non-finite samples. RSSI gauges retain their latest valid value; use last-seen to
assess freshness.

RSSI must be finite and between -120 and +20 dBm inclusive. Invalid values (including
BLE's unavailable sentinel) are excluded from the gauge. Cryptographic matches still
update presence and last-seen regardless of RSSI.

Example queries (documentation only):

```promql
# Source that saw each cat most recently
topk by (tag) (1, cat_source_last_seen_timestamp_seconds)

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

Mother no longer exposes `cat_bluetooth_*` metrics. Scanner health is reported
through the satellite's systemd journal. The `multer` override remains in place
for Nest's transitive dependency; this application has no upload routes.

## UDP packet metrics

`/metrics` also exports UDP satellite counters, labeled with the numeric satellite ID
(`satellite="7"`) where the frame header is valid:

- `cat_udp_packets_received_total` (counter): frames accepted in sequence order.
- `cat_udp_packets_lost_total` (counter): sequence numbers skipped between accepted
  frames of the same satellite and boot ID.
- `cat_udp_packets_stale_total` (counter): duplicate or older frames ignored. A
  reordered frame that arrives after a later one is counted as lost and then stale.
- `cat_udp_packets_invalid_total` (counter, unlabeled): malformed CatTag frames.
  Frames whose service data is not a valid Find Hub EID are ignored without being
  counted. Starts at zero.

Loss is inferred only from gaps. The first frame after a satellite boot or server
restart has no baseline, and frames lost after the last received one are not
counted until a later frame arrives. Frames with invalid service data do not advance
the sequence, so if a satellite numbers such frames they appear as loss.

```promql
# UDP drop rate per satellite over five minutes
rate(cat_udp_packets_lost_total[5m])
/ (rate(cat_udp_packets_lost_total[5m]) + rate(cat_udp_packets_received_total[5m]))
```
