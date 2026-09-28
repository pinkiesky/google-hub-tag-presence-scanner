# Cat presence monorepo

Two independently installable Node.js 24 / TypeScript applications, one test mock, and ESP32 firmware:

| Package                                                              | Responsibility                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [cat-presence-mother](cat-presence-mother/README.md)                 | NestJS HTTP/UDP ingestion, tag matching, SQLite, presence page and Prometheus metrics |
| [cat-presence-satellite-rpi](cat-presence-satellite-rpi/README.md)   | Raspberry Pi BLE scanning and raw advertisement forwarding over HTTP                  |
| [cat-presence-satellite-mock](cat-presence-satellite-mock/README.md) | Scripted FEAA observations for local and end-to-end tests                             |
| [cat-presence-satellite-esp32](cat-presence-satellite-esp32/)        | ESP32 BLE scanning and UDP forwarding                                                 |

Mother and RPi satellite each have their own `package.json`, lockfile, build,
tests and deployment scripts. Run `npm ci`, `npm run build`, `npm test`, and
`npm run lint` inside each package. The mock has no runtime dependencies; run `npm ci`, `npm start`, `npm test`,
`npm run lint`, and `npm run format:check` in its directory. After building mother and the RPi satellite, run
`node --test test/integration.cjs test/mock-integration.cjs` from the root to
verify both satellite paths through real HTTP into compiled mother. The
[repository test folder](./test/) contains these integration tests. There is no root npm install or shared runtime package. ESP32 firmware is a separate
PlatformIO project. Its Makefile finds `clang-format` and `cppcheck` on `PATH`,
or in the local VS Code C++ and PlatformIO tool directories. Install any missing
tool, then run `make prettify` from the monorepo root. It runs ESLint fixes
(and ESP32 cppcheck) in parallel, then runs the formatters in parallel.
Install each Node package with `npm ci` first. The ESP32 project also provides
`make format`, `make format-check`, and `make lint`.

Production tag identities, secret files, EID derivation and matching stay in
mother. The test mock reads only test tag secrets to produce matching EIDs.
RPi satellites send FEAA service-data bytes and RSSI as JSON. ESP32 satellites
send CatTag v7 frames over UDP to mother.

## Deployment

From either package directory, use:

```sh
./deploy/install_remote user@host
./deploy/setup_infra_remote user@host
# Configure that service, then:
./deploy/restart_remote user@host
# Subsequent updates:
./deploy/update_remote user@host
./deploy/restart_remote user@host
```

Scripts require SSH, rsync, noninteractive remote sudo, and Node.js 24 at
`/usr/bin/node`. Each package installs to `/opt/<package-name>` and has its own
service user and unit. Setup enables but does not start the application. Updates
preserve configuration and systemd overrides and do not restart automatically.
Only allowlisted package files are copied; local secrets, databases, `.env`,
`node_modules`, and development configuration are excluded. Deployments are
in-place, not atomic. Build native dependencies on the target architecture.

## Migration from cat-tracker

1. Stop and disable the old service: `sudo systemctl disable --now cat-tracker`.
2. Back up the existing database, for example:
   `sudo sqlite3 /var/lib/cat-tracker/presence.sqlite3 '.backup /var/lib/cat-tracker/presence.backup.sqlite3'`.
   Back up configuration and secrets separately with restricted permissions.
3. Install and set up mother. Its defaults still use `/etc/cat-tracker/config.json`
   and `/var/lib/cat-tracker/presence.sqlite3`; no database format change is needed.
   For an existing dedicated installation, transfer ownership with
   `sudo chown -R cat-presence-mother:cat-presence-mother /var/lib/cat-tracker`
   and `sudo chown -R root:cat-presence-mother /etc/cat-tracker`.
   Retain directory modes 0700 for state and 0750 for configuration, and mode 0640
   for configuration/secret files. Grant the mother user access to any externally
   located secret files too. Remove `adapter` and `scanner_cycle_seconds` from
   the service JSON; old extra fields are ignored.
4. If moving mother to another machine, transfer the stopped database and tag
   configuration/secrets securely to the same paths there, then apply ownership.
   Satellites must receive no copies of these files.
5. Install the satellite on each Pi and configure its systemd environment override
   as described in its README. Stop the old scanner before starting the new one;
   only one scanner should own an adapter.
6. Start mother, then satellites. Verify the page and metrics, new
   `satellite-rpi:<id>` sources, and existing UDP sources. Old persisted source
   names remain readable and are replaced when new observations arrive.
7. After verifying backups and mother, remove retired tag configuration/secrets
   from machines that now run only satellites. Keep backups on trusted storage.

Mother no longer exports `cat_bluetooth_*` metrics. Check satellite health using
`journalctl -u cat-presence-satellite-rpi`; adjust monitoring accordingly.
No remote deployment is performed by building or testing this repository.
