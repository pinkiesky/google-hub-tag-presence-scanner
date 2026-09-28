import { Controller, Get, Header } from '@nestjs/common';

import { CatStatus, PresenceService } from '../presence/presence.service';
import { WebViewService } from './web-view.service';

@Controller()
export class WebController {
  constructor(
    private readonly view: WebViewService,
    private readonly presence: PresenceService,
  ) {}

  @Get('/')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return this.view.render();
  }

  @Get('/style.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  style(): string {
    return this.view.css;
  }

  @Get('/app.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  script(): string {
    return this.view.js;
  }

  @Get('/api/tags')
  tags(): { tags: CatStatus[] } {
    return { tags: this.presence.getAllStatuses() };
  }
}
