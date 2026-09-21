import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PresenceService } from './presence.service';
import { DeliveryError, TelegramService } from '../notifications/telegram.service';
import { LifecycleService } from '../lifecycle.service';
@Injectable()
export class PresenceWatchdogService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private watchdog?: NodeJS.Timeout;
  private delivery?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private readonly abort = new AbortController();
  constructor(
    private readonly presence: PresenceService,
    private readonly telegram: TelegramService,
    private readonly lifecycle: LifecycleService,
  ) {}
  onApplicationBootstrap(): void {
    const tick = () => {
      try {
        this.presence.tick();
      } catch {
        this.lifecycle.fail('Presence watchdog database failure');
      }
    };
    tick();
    this.watchdog = setInterval(tick, this.presence.settings.watchdogIntervalSeconds * 1000);
    const dispatch = () => {
      this.pending = this.deliver()
        .catch(() => this.lifecycle.fail('Notification persistence failure'))
        .finally(() => {
          if (!this.abort.signal.aborted) this.delivery = setTimeout(dispatch, 1000);
        });
    };
    dispatch();
  }
  async deliver(): Promise<void> {
    // Drain available messages in order, as Python does, without blocking BLE.
    while (!this.abort.signal.aborted) {
      const item = this.presence.claim();
      if (!item) return;
      try {
        await this.telegram.send(item.message, this.abort.signal);
      } catch (error) {
        if (!(error instanceof DeliveryError)) throw error;
        this.presence.failed(item, undefined, error.retryAfter);
        new Logger('Notifications').warn(`Telegram error for tag ${item.tag_id}; retry scheduled`);
        continue;
      }
      this.presence.delivered(item);
    }
  }
  async beforeApplicationShutdown(): Promise<void> {
    clearInterval(this.watchdog);
    clearTimeout(this.delivery);
    this.abort.abort();
    await this.pending;
  }
}
