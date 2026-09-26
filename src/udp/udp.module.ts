import { Module } from '@nestjs/common';

import { FhnModule } from '../fhn/fhn.module';
import { MetricsModule } from '../metrics/metrics.module';
import { UdpService } from './udp.service';

@Module({ imports: [FhnModule, MetricsModule], providers: [UdpService] })
export class UdpModule {}
