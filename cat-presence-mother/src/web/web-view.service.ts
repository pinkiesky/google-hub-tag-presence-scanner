import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import { compileFile } from 'pug';

import { CatStatus, PresenceService } from '../presence/presence.service';
import { wallTime } from '../util/time';

export interface StatusPageViewModel {
  tags: CatStatus[];
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
  viewModel(now = wallTime()): StatusPageViewModel {
    return { tags: this.presence.getAllStatuses(now) };
  }

  render(now = wallTime()): string {
    return this.template(this.viewModel(now));
  }
}
