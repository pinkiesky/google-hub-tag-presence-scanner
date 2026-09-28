import { Observation } from './protocol';

/** One in-flight request; bounded live-only queue. Failed requests are never replayed. */
export class Forwarder {
  private readonly queue: Array<{ observation: Observation; receivedAt: number }> = [];
  private readonly abort = new AbortController();
  private timer?: NodeJS.Timeout;
  private reporting?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private pausedUntil = 0;
  private closed = false;
  private counts = { sent: 0, dropped: 0 };
  constructor(
    private readonly motherUrl: string,
    private readonly send: typeof fetch = fetch,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 100);
    this.reporting = setInterval(() => {
      console.log(
        `HTTP forwarding: sent=${this.counts.sent} dropped=${this.counts.dropped} queued=${this.queue.length}`,
      );
      this.counts = { sent: 0, dropped: 0 };
    }, 180_000);
  }

  enqueue(observation: Observation): void {
    if (this.closed) {
      return;
    }

    this.expire();

    if (this.queue.length >= 100) {
      this.queue.shift();
      this.counts.dropped++;
    }

    this.queue.push({ observation, receivedAt: performance.now() });
    this.tick();
  }

  private expire(): void {
    while (this.queue.length && performance.now() - this.queue[0].receivedAt > 2000) {
      this.queue.shift();
      this.counts.dropped++;
    }
  }

  private tick(): void {
    this.expire();

    if (this.closed || this.inFlight || performance.now() < this.pausedUntil) {
      return;
    }

    const next = this.queue.shift();

    if (!next) {
      return;
    }

    this.inFlight = this.post(next.observation).finally(() => {
      this.inFlight = undefined;
      this.tick();
    });
  }

  private async post(observation: Observation): Promise<void> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 2000);

    try {
      const response = await this.send(new URL('/api/v1/observations', this.motherUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(observation),
        redirect: 'error',
        signal: AbortSignal.any([this.abort.signal, timeout.signal]),
      });
      await response.body?.cancel();

      if (!response.ok) {
        throw new Error('HTTP request rejected');
      }

      this.counts.sent++;
    } catch {
      this.counts.dropped++;
      this.pausedUntil = performance.now() + 5000;

      if (!this.closed) {
        console.warn(
          'HTTP forwarding failed; dropping observation and pausing sending for 5 seconds',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.reporting);
    this.queue.length = 0;
    this.abort.abort();
    await this.inFlight;
  }
}
