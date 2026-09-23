import { Module } from '@nestjs/common';

import { FhnModule } from '../fhn/fhn.module';
import { MetricsModule } from '../metrics/metrics.module';
import { BluetoothService, createNoble, NOBLE_FACTORY } from './bluetooth.service';

@Module({
  imports: [FhnModule, MetricsModule],
  providers: [BluetoothService, { provide: NOBLE_FACTORY, useValue: createNoble }],
})
export class BluetoothModule {}
