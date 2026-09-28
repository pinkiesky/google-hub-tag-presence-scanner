# cat-presence-satellite-mock

Scripted Node.js 24 satellite for local and end-to-end testing. It sends the
same FEAA `POST /api/v1/observations` payload as the RPi satellite. No Bluetooth
adapter or runtime npm dependencies are needed. It repeats `TRIGGER_LINE` until stopped.

```sh
cd cat-presence-satellite-mock
npm ci
MOTHER_URL=http://127.0.0.1:15432 \
SATELLITE_ID=mock-1 \
TAG_CONFIG_PATH=/path/to/test/config.json \
TRIGGER_LINE='tag1:-40;delay 10;tag2:-60;tag1:-45;delay5' \
npm start
```

`TRIGGER_LINE` is a semicolon-separated sequence. `tag-id:-40` sends one
observation at that RSSI. `delay 10` and `delay10` both wait ten seconds;
fractional positive seconds also work. Steps execute in order and the sequence
restarts immediately after its last step. Include a delay to bound the loop rate.
Invalid steps, unknown tag IDs, and missing delays fail at startup.

`TAG_CONFIG_PATH` points to the same JSON tag configuration used by mother.
The mock reads the referenced test secret files (`eik_hex`, `pair_date`) and
respects `clock_offset_seconds`. It computes the current rotating EID for each
observation, so mother recognizes tag IDs in the script. Use **test-only tag
secrets** when running the mock. Relative `secret_file` paths resolve from the
configuration file's directory. `MOTHER_URL` must be an HTTP(S) origin and
`SATELLITE_ID` follows the RPi satellite ID format.

Each observation is sent once, with a two-second request timeout. Failed sends
are reported and the script continues. The next step starts after the HTTP
response or timeout. SIGINT/SIGTERM stop the loop and cancel an in-flight send.
Run `npm test` for parser, EID, and HTTP payload checks. The
[repository test folder](../test/) contains the mock-to-mother integration test.
Run `npm run lint` and `npm run format:check` for code checks; `npm run format`
applies formatting.
