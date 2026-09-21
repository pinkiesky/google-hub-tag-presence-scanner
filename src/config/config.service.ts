import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Configuration } from './configuration';
@Injectable()
export class TrackerConfig {
  constructor(private readonly config: ConfigService) {}
  get value(): Configuration { return this.config.getOrThrow<Configuration>('tracker'); }
  get settings() { return this.value.settings; }
  get tags() { return this.value.tags; }
}
