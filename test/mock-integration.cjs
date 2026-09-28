// Build mother first: cd cat-presence-mother && npm run build
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createSocket } = require('node:dgram');
const { once } = require('node:events');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const mother = resolve(__dirname, '../cat-presence-mother');
const mock = resolve(__dirname, '../cat-presence-satellite-mock');

async function freePort(udp = false) {
  const listener = udp ? createSocket('udp4') : createServer();
  if (udp) listener.bind(0, '127.0.0.1');
  else listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for mock observation');
}

test('mock trigger line reaches compiled mother', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cat-mock-integration-'));
  const port = await freePort();
  const udpPort = await freePort(true);
  const origin = `http://127.0.0.1:${port}`;
  writeFileSync(join(directory, 'tag.json'), JSON.stringify({
    version: 1, name: 'Mock Cat', pair_date: Math.floor(Date.now() / 1000) - 2048,
    eik_hex: '07'.repeat(32),
  }));
  writeFileSync(join(directory, 'config.json'), JSON.stringify({
    tags: [{ id: 'tag1', secret_file: 'tag.json' }],
  }));
  const motherChild = spawn(process.execPath, ['dist/main.js'], {
    cwd: mother,
    env: {
      PATH: process.env.PATH,
      TAG_CONFIG_PATH: join(directory, 'config.json'),
      DATABASE_PATH: join(directory, 'presence.sqlite3'),
      PORT: String(port), UDP_PORT: String(udpPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let motherOutput = '';
  for (const stream of [motherChild.stdout, motherChild.stderr]) {
    stream.on('data', (chunk) => { motherOutput += chunk; });
  }
  let mockChild;
  try {
    await until(async () => {
      if (motherChild.exitCode !== null) throw new Error(motherOutput);
      try { return (await fetch(origin)).ok; } catch { return false; }
    });
    mockChild = spawn(process.execPath, ['src/main.js'], {
      cwd: mock,
      env: {
        PATH: process.env.PATH,
        MOTHER_URL: origin, SATELLITE_ID: 'integration-mock',
        TAG_CONFIG_PATH: join(directory, 'config.json'),
        TRIGGER_LINE: 'tag1:-40;delay 0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let mockOutput = '';
    for (const stream of [mockChild.stdout, mockChild.stderr]) {
      stream.on('data', (chunk) => { mockOutput += chunk; });
    }
    await until(async () => {
      if (mockChild.exitCode !== null) throw new Error(mockOutput);
      const metrics = await (await fetch(`${origin}/metrics`)).text();
      return metrics.includes('cat_rssi_dbm{tag="tag1",source="satellite-rpi:integration-mock"} -40');
    });
    const page = await (await fetch(origin)).text();
    assert.match(page, /Mock Cat/);
    assert.match(page, /<td>Present<\/td>/);
  } finally {
    for (const child of [mockChild, motherChild]) {
      if (!child || child.exitCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(killTimer);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
