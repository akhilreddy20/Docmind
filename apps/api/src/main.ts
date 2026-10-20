import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { runMigrations } from './db/migrate';

async function bootstrap() {
  await runMigrations((m) => Logger.log(m, 'Migrations'));
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: config.corsOrigin.split(','), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(config.port);
  Logger.log(`DocuMind API listening on :${config.port}`, 'Bootstrap');
}
bootstrap();
