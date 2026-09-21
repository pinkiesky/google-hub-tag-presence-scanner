import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import { compileFile } from 'pug';

import { monotonicTime, PresenceService, utc, wallTime } from '../presence/presence.service';

export function timeAgo(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(seconds));
  const unit = elapsed < 60 ? 'second' : elapsed < 3600 ? 'minute' : 'hour';
  const count = Math.floor(elapsed / (elapsed < 60 ? 1 : elapsed < 3600 ? 60 : 3600));

  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

export function formatRssi(average: number): string {
  // Format exact ties to even; toFixed rounds them away from zero.
  // At one decimal place, .25 and .75 are the only binary-exact ties.
  const magnitude = Math.abs(average);
  const formatted =
    magnitude % 1 === 0.25
      ? `${average < 0 ? '-' : ''}${Math.floor(magnitude)}.2`
      : average.toFixed(1);

  return `${formatted} dBm`;
}
export interface StatusPageViewModel {
  generated: string;
  tags: Array<{
    id: string;
    name: string;
    status: string;
    lastSeen: string;
    average: string;
    alertSent: string;
  }>;
}

function assetPath(path: string): string {
  const compiled = join(__dirname, '..', path);

  return existsSync(compiled) ? compiled : join(__dirname, '../..', path);
}
@Injectable()
export class WebViewService {
  private readonly template = compileFile(assetPath('views/index.pug'), { compileDebug: false });
  readonly css = readFileSync(assetPath('public/style.css'), 'utf8');
  constructor(private readonly presence: PresenceService) {}
  viewModel(now = wallTime(), mono = monotonicTime()): StatusPageViewModel {
    return {
      generated: `${utc(now)} UTC`,
      tags: [...this.presence.states.values()].map((state) => {
        const average = this.presence.averageRssi(state.tag_id, mono);

        return {
          id: state.tag_id,
          name: state.name,
          // Alert confirmation has its own column.
          status:
            state.last_seen === null
              ? 'Never seen'
              : now - state.last_seen > this.presence.settings.missingAfterSeconds
                ? 'Missing'
                : 'Present',
          lastSeen: state.last_seen === null ? 'Never' : timeAgo(now - state.last_seen),
          average: average === null ? '—' : formatRssi(average),
          alertSent: state.alert_sent ? 'Yes' : 'No',
        };
      }),
    };
  }

  render(now = wallTime(), mono = monotonicTime()): string {
    return this.template(this.viewModel(now, mono));
  }
}
