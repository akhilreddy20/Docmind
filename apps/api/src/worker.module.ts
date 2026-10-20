import { Module } from '@nestjs/common';
import { CoreModule } from './common/core.module';
import { IngestionProcessor } from './ingestion/ingestion.processor';

/** Worker process: no HTTP server, only the BullMQ ingestion consumer. */
@Module({
  imports: [CoreModule],
  providers: [IngestionProcessor],
})
export class WorkerModule {}
