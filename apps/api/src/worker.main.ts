import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { runMigrations } from './db/migrate';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  await runMigrations((m) => Logger.log(m, 'Migrations'));
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // On SIGTERM Nest calls onModuleDestroy -> worker.close(), which waits for in-flight jobs.
  app.enableShutdownHooks();
  Logger.log('DocuMind ingestion worker ready', 'Bootstrap');
}
bootstrap();
