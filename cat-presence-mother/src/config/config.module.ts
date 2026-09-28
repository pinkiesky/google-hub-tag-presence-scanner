import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TrackerConfig } from './config.service';
import { loadConfiguration } from './configuration';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ tracker: loadConfiguration() })] }),
  ],
  providers: [TrackerConfig],
  exports: [TrackerConfig],
})
export class TrackerConfigModule {}
