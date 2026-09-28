// Build both independent packages before running: node --test test/integration.cjs
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createSocket } = require("node:dgram");
const { EventEmitter, once } = require("node:events");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const mother = resolve(__dirname, "../cat-presence-mother");
const satellite = resolve(__dirname, "../cat-presence-satellite-rpi");
const motherRequire = createRequire(join(mother, "package.json"));
const { EidService } = motherRequire("./dist/fhn/eid.service.js");
const { BluetoothService } = require(
  join(satellite, "dist/bluetooth.service.js"),
);
const { Forwarder } = require(join(satellite, "dist/forwarder.js"));

async function freePort(udp = false) {
  const listener = udp ? createSocket("udp4") : createServer();
  if (udp) listener.bind(0, "127.0.0.1");
  else listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function until(check, description) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

class FakeNoble extends EventEmitter {
  state = "poweredOn";
  scanning = false;
  async startScanningAsync(uuids, duplicates) {
    assert.deepEqual(uuids, ["feaa"]);
    assert.equal(duplicates, true);
    this.scanning = true;
  }
  async stopScanningAsync() {
    this.scanning = false;
    this.emit("scanStop");
  }
  stop() {}
}

test(
  "compiled satellite forwards BLE over HTTP to compiled mother without Bluetooth",
  { timeout: 15000 },
  async () => {
    const temporary = mkdtempSync(join(tmpdir(), "cat-split-integration-"));
    const port = await freePort();
    const udpPort = await freePort(true);
    const eik = Buffer.alloc(32, 7);
    const pairDate = Math.floor(Date.now() / 1000) - 2048;
    writeFileSync(
      join(temporary, "tag.json"),
      JSON.stringify({
        version: 1,
        name: "Test Cat",
        pair_date: pairDate,
        eik_hex: eik.toString("hex"),
      }),
    );
    writeFileSync(
      join(temporary, "config.json"),
      JSON.stringify({ tags: [{ id: "cat", secret_file: "tag.json" }] }),
    );
    // Deliberately supply no Bluetooth environment. Mother has no scanner dependency.
    const child = spawn(process.execPath, ["dist/main.js"], {
      cwd: mother,
      env: {
        PATH: process.env.PATH,
        TAG_CONFIG_PATH: join(temporary, "config.json"),
        DATABASE_PATH: join(temporary, "presence.sqlite3"),
        PORT: String(port),
        UDP_PORT: String(udpPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const exited = once(child, "exit");
    const origin = `http://127.0.0.1:${port}`;
    const forwarder = new Forwarder(origin);
    const noble = new FakeNoble();
    let failure;
    const scanner = new BluetoothService(
      {
        motherUrl: origin,
        satelliteId: "integration-pi",
        adapter: 0,
        scannerCycleSeconds: 300,
      },
      (packet) => forwarder.enqueue(packet),
      (message) => {
        failure = message;
      },
      () => noble,
    );
    try {
      await until(async () => {
        if (child.exitCode !== null) throw new Error(output);
        try {
          return (await fetch(origin)).ok;
        } catch {
          return false;
        }
      }, "mother startup");
      forwarder.start();
      scanner.onApplicationBootstrap();
      await until(() => noble.scanning, "scanner startup");
      const eid = new EidService().calculate(eik, 2048);
      noble.emit("discover", {
        rssi: -67,
        advertisement: {
          serviceData: [
            { uuid: "feaa", data: Buffer.concat([Buffer.from([0x40]), eid]) },
          ],
        },
      });
      await until(
        async () =>
          (await (await fetch(origin + "/metrics")).text()).includes(
            'cat_rssi_dbm{tag="cat",source="satellite-rpi:integration-pi"} -67',
          ),
        "HTTP presence observation",
      );
      const page = await (await fetch(origin)).text();
      assert.match(page, /Test Cat/);
      assert.match(page, /satellite-rpi:integration-pi/);
      assert.match(page, /<td>Present<\/td>/);
      assert.equal(failure, undefined);
      assert.doesNotMatch(
        await (await fetch(origin + "/metrics")).text(),
        /cat_bluetooth_/,
      );
    } finally {
      await Promise.all([
        scanner.beforeApplicationShutdown(),
        forwarder.stop(),
      ]);
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(killTimer);
      rmSync(temporary, { recursive: true, force: true });
    }
    // Nest finishes shutdown hooks, then re-emits the terminating signal.
    assert.equal(child.signalCode, "SIGTERM", output);
  },
);
