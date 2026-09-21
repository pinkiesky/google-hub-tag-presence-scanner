import { Injectable, Logger } from '@nestjs/common';
@Injectable()
export class LifecycleService {
  private closing = false;
  stopApplication?: () => Promise<void>;
  fail(reason: string): void {
    if (this.closing) return;
    this.closing = true;
    new Logger('Lifecycle').error(reason);
    process.exitCode = 1;
    // Schedule closure outside callbacks/worker promises to avoid self-await.
    setImmediate(() => {
      void this.stopApplication?.().catch(() => {
        process.exitCode = 1;
      });
    });
  }
}
