import { DynamicModule, Module } from '@nestjs/common';

import { FhnModule } from '../fhn/fhn.module';
import { BluetoothService, createNoble, NOBLE_FACTORY } from './bluetooth.service';

@Module({})
export class BluetoothModule {
  static register(debugScan: boolean): DynamicModule {
    return {
      module: BluetoothModule,
      imports: [FhnModule.register(debugScan)],
      providers: [BluetoothService, { provide: NOBLE_FACTORY, useValue: createNoble }],
    };
  }
}
