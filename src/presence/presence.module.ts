import { Module } from '@nestjs/common';

import { PersistenceModule } from '../persistence/persistence.module';
import { PresenceService } from './presence.service';

@Module({ imports: [PersistenceModule], providers: [PresenceService], exports: [PresenceService] })
export class PresenceModule {}
