import { Controller, Get, Header } from '@nestjs/common';

import { WebViewService } from './web-view.service';

@Controller()
export class WebController {
  constructor(private readonly view: WebViewService) {}
  @Get(['/', '/index.html'])
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return this.view.render();
  }

  @Get('/style.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  style(): string {
    return this.view.css;
  }
}
