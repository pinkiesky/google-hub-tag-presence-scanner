import { Module } from '@nestjs/common';

import { TagObservationModule } from '../observations/tag-observation.module';
import { EidService } from './eid.service';
import { FhnParserService } from './fhn-parser.service';
import { TagMatcherService } from './tag-matcher.service';

@Module({
  imports: [TagObservationModule],
  providers: [EidService, FhnParserService, TagMatcherService],
  exports: [FhnParserService, TagMatcherService],
})
export class FhnModule {}
