import { Body, Controller, HttpCode, Module, Post, UsePipes, ValidationPipe } from '@nestjs/common';

import { FhnModule } from '../fhn/fhn.module';
import { FhnParserService } from '../fhn/fhn-parser.service';
import { TagMatcherService } from '../fhn/tag-matcher.service';
import { wallTime } from '../util/time';
import { ObservationDto } from './observation.dto';

@Controller('/api/v1/observations')
export class HttpObservationController {
  constructor(
    private readonly parser: FhnParserService,
    private readonly matcher: TagMatcherService,
  ) {}

  @Post()
  @HttpCode(204)
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidUnknownValues: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  )
  accept(@Body() body: ObservationDto): void {
    const { satelliteId, serviceUuid, serviceDataHex, rssi } = body;

    const eid = this.parser.parse([
      { uuid: serviceUuid, data: Buffer.from(serviceDataHex, 'hex') },
    ]);

    if (eid) {
      this.matcher.observe(eid, rssi, wallTime(), `satellite-rpi:${satelliteId}`);
    }
  }
}

@Module({ imports: [FhnModule], controllers: [HttpObservationController] })
export class HttpObservationModule {}
