# Migration validation — 2026-09-21

Target: `192.168.0.123`, Raspberry Pi OS ARM64, Node.js 24.21.0. The deployment
retains the existing service user, configuration/secrets, port 15432, and database
at `/var/lib/cat-tracker/presence.sqlite3`.

## Completed checks

- Original Python suite: 44 tests passed. Python code and tests remain unchanged.
- TypeScript suite: 96 tests passed locally and on ARM64; build and lint passed.
- Clean local `npm ci` succeeded. ARM64 native dependency installation succeeded.
- Final dependency audit: zero reported vulnerabilities.
- All 40 synthetic Python-generated EID vectors matched compiled Node output.
- On the Pi, 12 additional EID comparisons using both actual tag configurations,
  two EID sizes, and three clock offsets matched. Keys stayed on the Pi.
- Python captured 25 real matched observations from both `cat-a` and `cat-b`.
  Node matched every captured EID to the same ID at its original timestamp.
- The production Node scanner receives both real tags continuously through hci0,
  with duplicate observations, no advertised-service UUID filter, and only
  `CAP_NET_RAW`. Recent 30-second summaries contained 44–52 matches and no unmatched
  Find Hub EIDs.
- `GET /` returns complete HTML with both tags, current UTC last-seen values,
  RSSI averages, and alert confirmation. CSS loads separately. No browser script
  or status endpoint is used. Tests cover HEAD, index alias, 404s, LAN filtering,
  escaping and secret exclusion.
- Existing creation times, episodes, last-seen and alert state survived migration
  and systemd restarts. SQLite `integrity_check` returned `ok`; the production
  outbox was empty after recovery.
- The native scanner completed its five-minute scheduled restart and resumed
  matching both tags without a process restart. Real captured tags use 20-byte EIDs;
  32-byte EIDs are covered by crypto/parser tests, not by this physical capture.
- SIGINT completed graceful shutdown at 08:04:46 UTC; systemd restarted after
  five seconds and both tags were detected again. The single recorded automatic
  restart was this intentional signal test, not a crash.
- Python and Node service stops completed successfully under systemd. The
  production unit executes `/usr/bin/node /opt/cat-tracker/dist/main.js`.

## Retained rollback assets

On the Pi, root-only `/var/backups/cat-tracker` contains:

- `python-before-node.service`
- `python-before-node.tar.gz`
- `presence-before-node.sqlite3` (SQLite online backup)

The original `/opt/cat-tracker/.venv` and Python source remain installed. To roll
back, stop the service, restore `python-before-node.service` to
`/etc/systemd/system/cat-tracker.service`, daemon-reload and start. Keep the current
database to retain observations since the migration; both runtimes use its schema.

The private capture is `/var/lib/cat-tracker/migration-advertisements.json`. It
contains rotating EIDs, never EIKs, and is not copied into this repository.

## Scope of validation

Presence thresholds, grace, retry timing, per-tag ordering, mid-flight recovery,
second disappearance, database restart behavior and scanner failure/backoff are
automated tests. Real radio reception and service restarts were checked on the Pi.
A full one-hour physical disappearance and Raspberry Pi power-cycle were not
performed. Those require a longer commissioning window. The default 3600-second
alert threshold and 120-second startup grace remain unchanged.

Live Node Telegram test messages have not been sent; the isolated probe is ready
and awaits permission. Real Python recovery messages were confirmed when the tags
were brought near the Pi. Node notification state transitions and HTTP handling
are covered by the automated tests.
