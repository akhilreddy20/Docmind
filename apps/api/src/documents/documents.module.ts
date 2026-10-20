import { Module } from '@nestjs/common';
import { IngestionQueue } from '../ingestion/ingestion.queue';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService, IngestionQueue],
})
export class DocumentsModule {}
