import { DynamicModule, Module } from '@nestjs/common';

import { TagObservationModule } from '../observations/tag-observation.module';
import { EidService } from './eid.service';
import { FhnParserService } from './fhn-parser.service';
import { TagMatcherService } from './tag-matcher.service';

@Module({
  providers: [EidService, FhnParserService, TagMatcherService],
  exports: [FhnParserService, TagMatcherService],
})
export class FhnModule {
  static register(debugScan: boolean): DynamicModule {
    return { module: FhnModule, imports: debugScan ? [] : [TagObservationModule] };
  }
}
