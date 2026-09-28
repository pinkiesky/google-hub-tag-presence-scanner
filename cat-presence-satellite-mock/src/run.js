const { setTimeout: delay } = require('node:timers/promises');

const { calculateEid } = require('./eid');

async function run(config, { send = fetch, now = Date.now, signal, onStep = () => {} } = {}) {
  const endpoint = new URL('/api/v1/observations', config.motherUrl);

  while (!signal?.aborted) {
    for (const step of config.steps) {
      if (signal?.aborted) {
        return;
      }

      if (step.type === 'delay') {
        try {
          await delay(step.milliseconds, undefined, { signal });
        } catch (error) {
          if (signal?.aborted) {
            return;
          }

          throw error;
        }

        continue;
      }

      const tag = config.tags.get(step.tagId);
      const eid = calculateEid(tag, Math.floor(now() / 1000));
      const observation = {
        satelliteId: config.satelliteId,
        serviceUuid: 'feaa',
        serviceDataHex: `40${eid.toString('hex')}`,
        rssi: step.rssi,
      };
      const timeout = AbortSignal.timeout(2000);

      try {
        const response = await send(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(observation),
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        await response.body?.cancel();

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        onStep({ ...step, sent: true });
      } catch (error) {
        if (signal?.aborted) {
          return;
        }

        onStep({ ...step, sent: false, error });
      }
    }
  }
}

module.exports = { run };
