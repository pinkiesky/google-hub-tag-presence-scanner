import 'reflect-metadata';
import { ConsoleLogger, INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigurationError } from './config/configuration';
import { TrackerConfig } from './config/config.service';
import { LifecycleService } from './lifecycle.service';
async function bootstrap(): Promise<void> {
  process.umask(0o077);
  const debugScan = process.argv.includes('--debug-scan');
  const options = { abortOnError: false, logger: false as const };
  // Keep DI/configuration exceptions out of Nest's automatic exception logger.
  const app = debugScan
    ? await NestFactory.createApplicationContext(AppModule.register(true), options)
    : await NestFactory.create(AppModule.register(), options);
  app.useLogger(
    new ConsoleLogger({
      logLevels: process.argv.includes('--debug')
        ? ['log', 'warn', 'error', 'debug']
        : ['log', 'warn', 'error'],
    }),
  );
  const lifecycle = app.get(LifecycleService);
  lifecycle.stopApplication = () => app.close();
  app.enableShutdownHooks();
  try {
    if ('listen' in app) {
      await (app as INestApplication).listen(app.get(TrackerConfig).settings.port, '0.0.0.0');
      const server = (app as INestApplication).getHttpServer() as import('node:http').Server;
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.setTimeout(3000);
    }
    new Logger('Bootstrap').log(
      `Application started; monitoring ${app.get(TrackerConfig).tags.length} tags${debugScan ? '' : '; SQLite opened'}`,
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
      : 'Service failed; check configuration, permissions and Bluetooth',
  );
  process.exitCode = 1;
});
