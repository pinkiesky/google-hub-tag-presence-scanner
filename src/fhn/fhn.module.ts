import { Module } from '@nestjs/common';
import { EidService } from './eid.service';
import { FhnParserService } from './fhn-parser.service';
import { TagMatcherService } from './tag-matcher.service';
@Module({
  providers: [EidService, FhnParserService, TagMatcherService],
  exports: [FhnParserService, TagMatcherService],
})
export class FhnModule {}
