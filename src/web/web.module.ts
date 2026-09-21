import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { isIPv4 } from 'node:net';
import { Request, Response, NextFunction } from 'express';
import { PresenceModule } from '../presence/presence.module';
import { WebController } from './web.controller';
import { WebViewService } from './web-view.service';
export function allowedClient(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}
@Module({ imports: [PresenceModule], controllers: [WebController], providers: [WebViewService] })
export class WebModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply((req: Request, res: Response, next: NextFunction) => {
      // Use the socket peer, never proxy-controlled forwarded headers.
      if (!allowedClient(req.socket.remoteAddress ?? '')) { res.status(403).end(); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; frame-ancestors 'none'");
      next();
    }).forRoutes('{*path}');
  }
}
