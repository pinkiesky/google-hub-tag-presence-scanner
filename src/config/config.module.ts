import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loadConfiguration } from './configuration';
import { TrackerConfig } from './config.service';
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ tracker: loadConfiguration() })] }),
  ],
  providers: [TrackerConfig],
  exports: [TrackerConfig],
})
export class TrackerConfigModule {}
