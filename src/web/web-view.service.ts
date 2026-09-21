import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PresenceService, utc, wallTime, monotonicTime } from '../presence/presence.service';
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[char]!);
}
export function formatRssi(average: number): string {
  // Python formats exact ties to even; toFixed rounds them away from zero.
  // At one decimal place, .25 and .75 are the only binary-exact ties.
  const magnitude = Math.abs(average);
  const formatted = magnitude % 1 === 0.25
    ? `${average < 0 ? '-' : ''}${Math.floor(magnitude)}.2` : average.toFixed(1);
  return `${formatted} dBm`;
}
export interface StatusPageViewModel {
  generated: string;
  tags: Array<{ id: string; name: string; status: string; lastSeen: string; average: string; alertSent: string }>;
}
function asset(path: string): string {
  const compiled = join(__dirname, '..', path);
  return readFileSync(existsSync(compiled) ? compiled : join(__dirname, '../..', path), 'utf8');
}
@Injectable()
export class WebViewService {
  private readonly template = asset('views/index.html');
  readonly css = asset('public/style.css');
  constructor(private readonly presence: PresenceService) {}
  viewModel(now = wallTime(), mono = monotonicTime()): StatusPageViewModel {
    return { generated: `${utc(now)} UTC`, tags: [...this.presence.states.values()].map(state => {
      const average = this.presence.averageRssi(state.tag_id, mono);
      return { id: state.tag_id, name: state.name,
        // Preserve Python's labels: alert confirmation has its own column.
        status: state.last_seen === null ? 'Never seen' : now - state.last_seen > this.presence.settings.missingAfterSeconds ? 'Missing' : 'Present',
        lastSeen: state.last_seen === null ? 'Never' : utc(state.last_seen),
        average: average === null ? '—' : formatRssi(average), alertSent: state.alert_sent ? 'Yes' : 'No' };
    }) };
  }
  render(now = wallTime(), mono = monotonicTime()): string {
    const model = this.viewModel(now, mono);
    const rows = model.tags.map(tag => `<tr><th scope='row'>${escapeHtml(tag.name)}<small>${escapeHtml(tag.id)}</small></th>` +
      [tag.status, tag.lastSeen, tag.average, tag.alertSent].map(value => `<td>${escapeHtml(value)}</td>`).join('') + '</tr>').join('');
    return this.template.replace('{{generated}}', () => escapeHtml(model.generated)).replace('{{rows}}', () => rows);
  }
}
