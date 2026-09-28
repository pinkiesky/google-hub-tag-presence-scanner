import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import { compileFile } from 'pug';

function assetPath(path: string): string {
  const compiled = join(__dirname, '..', path);

  return existsSync(compiled) ? compiled : join(__dirname, '../..', path);
}

@Injectable()
export class WebViewService {
  private readonly template = compileFile(assetPath('views/realtime.pug'), { compileDebug: false });
  readonly css = readFileSync(assetPath('public/style.css'), 'utf8');
  readonly js = readFileSync(assetPath('public/app.js'), 'utf8');

  render(): string {
    return this.template();
  }
}
