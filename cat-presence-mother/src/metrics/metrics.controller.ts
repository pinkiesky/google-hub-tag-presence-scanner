import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';

import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async get(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('Content-Type', this.metrics.getContentType());

    return this.metrics.getMetrics();
  }
}
