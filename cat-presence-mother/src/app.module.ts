import { DynamicModule, Global, Module } from '@nestjs/common';

import { TrackerConfigModule } from './config/config.module';
import { HttpObservationModule } from './http/http.module';
import { LifecycleService } from './lifecycle.service';
import { UdpModule } from './udp/udp.module';
import { WebModule } from './web/web.module';

@Global()
@Module({ providers: [LifecycleService], exports: [LifecycleService] })
class LifecycleModule {}
@Module({})
export class AppModule {
  static register(): DynamicModule {
    return {
      module: AppModule,
      imports: [TrackerConfigModule, LifecycleModule, HttpObservationModule, UdpModule, WebModule],
    };
  }
}
