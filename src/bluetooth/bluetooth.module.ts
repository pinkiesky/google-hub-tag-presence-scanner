import { DynamicModule, Module } from '@nestjs/common';
import { FhnModule } from '../fhn/fhn.module';
import { PresenceModule } from '../presence/presence.module';
import { BluetoothService, createNoble, NOBLE_FACTORY } from './bluetooth.service';
@Module({})
export class BluetoothModule {
  static register(debugScan: boolean): DynamicModule {
    return {
      module: BluetoothModule,
      imports: [FhnModule, ...(debugScan ? [] : [PresenceModule])],
      providers: [BluetoothService, { provide: NOBLE_FACTORY, useValue: createNoble }],
    };
  }
}
