import { run } from './run';

void run(true).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Diagnostic scanner failed');
  process.exitCode = 1;
});
