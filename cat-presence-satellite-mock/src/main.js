const { loadConfig } = require('./config');
const { run } = require('./run');

async function main() {
  const config = loadConfig();
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  console.log(
    `Mock satellite ${config.satelliteId}: running ${config.steps.length} steps in a loop`,
  );
  await run(config, {
    signal: abort.signal,
    onStep: (step) => {
      if (step.sent) {
        console.log(`Sent ${step.tagId} RSSI ${step.rssi}`);
      } else {
        console.warn(`Failed to send ${step.tagId}: ${step.error?.message ?? 'unknown error'}`);
      }
    },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Mock satellite failed');
  process.exitCode = 1;
});
