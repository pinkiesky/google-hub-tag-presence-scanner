import { Module } from '@nestjs/common';

import { MetricsModule } from '../metrics/metrics.module';
import { PresenceModule } from '../presence/presence.module';
import { TagObservationService } from './tag-observation.service';

@Module({
  imports: [PresenceModule, MetricsModule],
  providers: [TagObservationService],
  exports: [TagObservationService],
})
export class TagObservationModule {}
