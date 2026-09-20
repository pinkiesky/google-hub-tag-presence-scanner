# Cat tracker

A single Python 3.11+ process monitors local Google Find Hub BLE advertisements and
sends Telegram messages after an absence longer than one hour, then on recovery.
Two or more tags share one scanner. Presence depends on a matching rotating EID;
RSSI is diagnostic only. No Google login, location API, or Internet connection is
needed for tracking.

## Raspberry Pi installation

The four scripts in `deploy/` run locally and accept your Pi's SSH destination.
They require SSH access, `rsync` on both machines, and noninteractive sudo
(`sudo -n`) for the remote deployment user. They also work with an SSH config
alias (configure a custom port/key in `~/.ssh/config`). Paths are fixed to
`/opt/cat-tracker`, `/etc/cat-tracker`, and `/var/lib/cat-tracker`.

For first installation:

```sh
# If rsync is not already installed on the Pi:
ssh -t pi@raspberrypi.local 'sudo apt-get update && sudo apt-get install -y rsync'
./deploy/install_remote pi@raspberrypi.local
./deploy/setup_infra_remote pi@raspberrypi.local
```

`install_remote` copies only application source, package metadata, documentation,
configuration examples and deployment files into `/opt/cat-tracker`.
`setup_infra_remote` installs OS/Python dependencies, creates the dedicated user,
installs the BlueZ D-Bus policy and systemd unit, powers on Bluetooth, and enables
the tracker at boot. It creates configuration templates only when missing.
Python 3.11+ is required; the script stops with an explanation on older versions.

Before starting, edit `/etc/cat-tracker/config.toml` and
`/etc/cat-tracker/telegram.env`, then install the two secret JSON files using the
commands below. The setup script does not start the tracker with placeholder
credentials. Once configured:

```sh
./deploy/restart_remote pi@raspberrypi.local
```

For later updates:

```sh
./deploy/update_remote pi@raspberrypi.local
./deploy/restart_remote pi@raspberrypi.local
```

`update_remote` copies current application files, removes stale source files,
installs the Python package and refreshes the systemd/D-Bus definitions. It does
not restart the process; run `restart_remote` immediately afterward. These are
simple in-place updates, not atomic deployments. All scripts stop on errors.
Existing credentials, configuration and presence history are preserved. Local
virtual environments, databases and secret files are not uploaded. Keep secrets
outside `src/cat_tracker`, which is copied as application source.

The scripts can be run from any working directory. No command is run remotely
until you invoke a script. For manual installation, use the steps below instead.

Use Raspberry Pi OS with Python 3.11 or newer, BlueZ 5.55+, and a working Bluetooth
adapter. Check the installed Python version first: older OS releases may provide
Python 3.10 or earlier; upgrade the OS or install a separately maintained Python 3.11+ and
use that interpreter to create the venv. Do not replace the OS Python.

```sh
sudo apt update
sudo apt install -y python3 python3-venv python3-dev build-essential bluez libbluetooth-dev sqlite3
python3 --version
sudo systemctl enable --now bluetooth
sudo bluetoothctl power on
sudo groupadd --system --force bluetooth
sudo useradd --system --user-group --home-dir /var/lib/cat-tracker --no-create-home --shell /usr/sbin/nologin cat-tracker
sudo usermod -aG bluetooth cat-tracker
sudo install -d -m 0755 /opt/cat-tracker
sudo install -d -o root -g cat-tracker -m 0750 /etc/cat-tracker
```

From this checkout (the copy commands intentionally exclude local secrets):

```sh
sudo cp pyproject.toml README.md /opt/cat-tracker/
sudo cp -r src /opt/cat-tracker/
sudo python3 -m venv /opt/cat-tracker/.venv
sudo /opt/cat-tracker/.venv/bin/python -m pip install /opt/cat-tracker
sudo install -o root -g cat-tracker -m 0640 config.example.toml /etc/cat-tracker/config.toml
sudo install -o root -g root -m 0600 .env.example /etc/cat-tracker/telegram.env
sudoedit /etc/cat-tracker/config.toml
sudoedit /etc/cat-tracker/telegram.env
```

Create a bot with Telegram's BotFather, obtain your destination chat ID, and initiate
a chat with the bot (or add it to the target group). Set `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` in `telegram.env`. No polling/webhooks run in this service.
Environment files are loaded by systemd, not by Python; for foreground execution,
export the two variables in your shell. Never commit them or paste them into logs.

Install your existing secret files:

```sh
sudo install -o root -g cat-tracker -m 0640 /path/to/cat-a.json /etc/cat-tracker/cat-a.json
sudo install -o root -g cat-tracker -m 0640 /path/to/cat-b.json /etc/cat-tracker/cat-b.json
sudo install -m 0644 deploy/cat-tracker.service /etc/systemd/system/cat-tracker.service
sudo systemctl daemon-reload
sudo systemctl enable --now cat-tracker
sudo systemctl status cat-tracker
sudo journalctl -u cat-tracker -f
sudo journalctl -u cat-tracker --since today
```

A secret has `version: 1`, a nonempty `name`, integer UTC Unix `pair_date`, and
`eik_hex` with exactly 64 hexadecimal characters. Manufacturer/model metadata is
ignored. Keys never belong in the main TOML. IDs must remain stable across restarts;
changing an ID starts a new timer. Restart after changing config or secrets.
Unreadable/invalid tag secrets disable just that tag with an ERROR; no valid tags
is fatal. Duplicate keys are rejected to avoid assigning observations arbitrarily.

## Bluetooth permissions and diagnostics

Bleak uses the system D-Bus BlueZ service, so raw HCI sockets and root are not
required. The dedicated user needs permission to send to `org.bluez`. Raspberry Pi
OS policy commonly grants this to `bluetooth`; verify on the target OS:

```sh
sudo -u cat-tracker /opt/cat-tracker/.venv/bin/cat-tracker --config /etc/cat-tracker/config.toml --debug-scan
```

This command prints matched tag IDs and RSSI, does not open the database, and does
not require Telegram credentials. Stop the normal service during this hardware
check to avoid competing discovery clients. Exit with Ctrl-C. `--debug` also shows
matched observations in normal service mode. Raw advertisements and EIKs
are never logged. Every 30 seconds, INFO logs summarize all received advertisements,
non-FEAA traffic (`other`), invalid FEAA frames, unmatched EIDs and matched tags with
latest RSSI. Scanning has no service UUID filter: FEAA service data can be present
without FEAA in the advertised service UUID list. Filtering happens in our parser.

If D-Bus denies access, install the included policy for this user:

```sh
sudo install -m 0644 deploy/90-cat-tracker-bluetooth.conf /etc/dbus-1/system.d/90-cat-tracker-bluetooth.conf
sudo systemctl reload dbus
sudo systemctl restart cat-tracker
```

This allows the user to call BlueZ; it is not a per-adapter access restriction.
Check `bluetoothctl show`, rfkill state, adapter selection (`hci0` by default), and
journald if discovery fails. 32-byte EIDs require extended advertisement support
in the adapter/BlueZ stack. The service retries scanner errors with bounded backoff
and exits after five consecutive short failures. Discovery is restarted every
five minutes to recover silent backend disconnects, with only one scanner active
at a time. This introduces a short scan gap. A dead radio cannot reliably be
distinguished from both tags being absent: missing messages mean **not detected**,
not proof that a cat left home. Monitor BLE errors in journald.

## Clock and EID compatibility

The implementation follows Google's [FHN accessory specification](https://developers.google.com/nearby/fast-pair/specifications/extensions/fmdn):
AES-256-ECB derives a scalar for secp160r1 or secp256r1, and its public x-coordinate
is the 20- or 32-byte EID. Rotation is 1024 seconds. Both frame types and optional
hashed flags are parsed. Expected identifiers are cached, refreshed as each tag's
rotation window changes, with 16 neighboring windows on either side by default
(about ±4.5 hours), matching the supplied working prototype.

**Clock assumption:** `beacon_seconds = UTC_now - pair_date + clock_offset_seconds`.
This matches the supplied working prototype's clock calculation. The EIK alone
does not determine a beacon's clock origin. If pairing did not occur at clock zero,
set the per-tag signed `clock_offset_seconds` to the known clock at `pair_date`.
Existing configurations should set `drift_windows = 16` for the same tolerance.
Adjust `drift_windows` (1–32) for drift; a large clock reset needs a corrected
clock offset. This service neither pairs nor changes tags. No API fallback exists.

Keep the Pi clock synchronized with NTP. UTC wall timestamps persist across
reboots; startup grace and scanner scheduling use monotonic time. Large wall-clock
corrections can advance or delay absence alerts until the clock is corrected.
`time-sync.target` orders startup but does not itself guarantee a successful NTP
sync on every distribution. Verify time before commissioning the service.
A matching broadcast is evidence of local reception, not replay-proof ranging.

## State and delivery behavior

Each tag stores `last_seen`, latest RSSI, alert status, absence start and an episode
number in SQLite. After 60 seconds without observations it is marked missing;
a notification is queued only once the absence is **strictly greater** than the
configured timeout. Checks run every 30 seconds, so delivery normally occurs
within one watchdog interval after the threshold. A never-seen tag's timer starts
at its first service start and persists across restarts; its alert says "never".
The two-minute startup grace suppresses delivery while fresh observations arrive.

All state changes and SQLite transactions run synchronously on one asyncio event
loop with no awaits inside transactions. BLE callbacks never await Telegram.
A single notification worker performs bounded HTTP requests while scanning and
the watchdog continue. An outbox transaction couples state transitions with
pending notifications. Per-tag delivery order is preserved; a failed tag's
message does not prevent the other tag being processed. A file lock prevents two
service processes sharing the same database.

Success requires an HTTP success and Telegram `ok: true`; only then is the alert
marked sent. Retries back off from 30 seconds to 15 minutes and honor Telegram's
`retry_after`. Pending recoveries survive restarts. If a tag returns before an
absence message begins sending, that stale alert is canceled. If the tag returns
during an in-flight request, its recovery is queued behind that absence; delayed
messages may therefore describe an already-completed absence. Episode IDs stop
late acknowledgments from marking a newer absence as alerted.

Telegram `sendMessage` has no idempotency key. If Telegram accepts a message but
the response is lost, or the process dies before recording success, retrying can
produce a duplicate. Exactly-once external delivery is impossible in this case;
normal confirmed deliveries and recoveries are deduplicated locally. No repeated
alerts are generated for a continuously missing tag after confirmed delivery.

SQLite uses WAL and FULL synchronization. Database errors fail the service rather
than silently losing presence state. The database stores names and timestamps,
not EIKs or Telegram credentials. The systemd state directory is private. Back up
with SQLite's online backup command, or stop the service before copying the
DB/WAL together. Do not delete the database on restart: doing so resets timers.
Disk corruption/full-disk errors require operator repair; the service does not
silently recreate a corrupt database. Outbox rows for disabled/removed tags stay
stored but are not delivered until those IDs are enabled again.

## Development and tests

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/pytest
.venv/bin/ruff check src tests
.venv/bin/mypy src
.venv/bin/cat-tracker --config config.example.toml --debug-scan
```

Tests use synthetic keys, mock HTTP, temporary SQLite files and no BLE hardware.
They cover independent cryptographic cross-checks, parsing, cache/drift behavior,
thresholds, independent tags, retry/recovery cycles, restarts, startup grace, and
observations arriving during notification delivery. Before production, confirm
matches from both real tags using debug scan, then test disappearance/recovery
with a short timeout (and a shorter `missing_after_seconds`) before restoring
3600 seconds. Real Pi radio and Telegram delivery require commissioning on your
hardware with your credentials.

References: [Bleak Linux backend](https://bleak.readthedocs.io/en/latest/backends/linux.html),
[Telegram Bot API](https://core.telegram.org/bots/api#sendmessage).
