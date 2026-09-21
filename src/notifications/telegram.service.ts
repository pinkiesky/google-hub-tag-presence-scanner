import { Injectable } from '@nestjs/common';

import { TrackerConfig } from '../config/config.service';

export class DeliveryError extends Error {
  constructor(readonly retryAfter = 0) {
    super('Telegram delivery failed');
  }
}
@Injectable()
export class TelegramService {
  constructor(private readonly config: TrackerConfig) {}
  async send(message: string, signal?: AbortSignal): Promise<void> {
    try {
      const timeout = AbortSignal.timeout(20_000);
      const response = await fetch(
        `https://api.telegram.org/bot${this.config.value.token}/sendMessage`,
        {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.config.value.chatId, text: message }),
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        },
      );
      const data: unknown = await response.json();

      if (!data || typeof data !== 'object') {
        throw new DeliveryError();
      }

      const result = data as { ok?: unknown; parameters?: { retry_after?: unknown } };

      if (response.ok && result.ok === true) {
        return;
      }

      const retry = result.parameters?.retry_after;
      throw new DeliveryError(typeof retry === 'number' && retry > 0 && retry < 86400 ? retry : 0);
    } catch (error) {
      // Fetch errors include the URL/token; propagate only our sanitized error.
      throw error instanceof DeliveryError ? error : new DeliveryError();
    }
  }
}
