import 'reflect-metadata';

import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { TrackerConfig } from './config/config.service';
import { ConfigurationError } from './config/configuration';
import { LifecycleService } from './lifecycle.service';

async function bootstrap(): Promise<void> {
  process.umask(0o077);
  const options = { abortOnError: false, logger: false as const };
  // Keep DI/configuration exceptions out of Nest's automatic exception logger.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(), options);
  app.useBodyParser('json', { limit: '4kb' });
  app.useLogger(new ConsoleLogger({ logLevels: ['log', 'warn', 'error'] }));
  const lifecycle = app.get(LifecycleService);
  lifecycle.stopApplication = () => app.close();
  app.enableShutdownHooks();

  try {
    await app.listen(app.get(TrackerConfig).settings.port, '0.0.0.0');
    const server = app.getHttpServer() as import('node:http').Server;
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.setTimeout(3000);

    new Logger('Bootstrap').log(
      `Application started; monitoring ${app.get(TrackerConfig).tags.length} tags; SQLite opened`,
    );
  } catch {
    await app.close();
    throw new Error('Application startup failed');
  }
}

void bootstrap().catch((error: unknown) => {
  Logger.overrideLogger(new ConsoleLogger({ logLevels: ['error'] }));
  new Logger('Bootstrap').error(
    error instanceof ConfigurationError
      ? error.message
      : 'Service failed; check configuration, permissions and storage',
  );
  process.exitCode = 1;
});
