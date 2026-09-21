import { Module } from '@nestjs/common';
import { PresenceModule } from '../presence/presence.module';
import { PresenceWatchdogService } from '../presence/presence-watchdog.service';
import { TelegramService } from './telegram.service';
@Module({ imports: [PresenceModule], providers: [TelegramService, PresenceWatchdogService] })
export class NotificationsModule {}
