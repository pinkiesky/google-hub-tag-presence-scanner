import { run } from './run';

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Satellite failed');
  process.exitCode = 1;
});
