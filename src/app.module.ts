import { DynamicModule, Global, Module } from '@nestjs/common';
import { TrackerConfigModule } from './config/config.module';
import { BluetoothModule } from './bluetooth/bluetooth.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WebModule } from './web/web.module';
import { LifecycleService } from './lifecycle.service';
@Global()
@Module({ providers: [LifecycleService], exports: [LifecycleService] })
class LifecycleModule {}
@Module({})
export class AppModule {
  static register(debugScan = false): DynamicModule {
    return { module: AppModule, imports: [TrackerConfigModule, LifecycleModule,
      BluetoothModule.register(debugScan), ...(debugScan ? [] : [NotificationsModule, WebModule])] };
  }
}
