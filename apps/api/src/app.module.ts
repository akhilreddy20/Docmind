import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './common/core.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthController } from './health/health.controller';
import { QueryModule } from './query/query.module';

@Module({
  imports: [CoreModule, AuthModule, DocumentsModule, QueryModule],
  controllers: [HealthController],
})
export class AppModule {}
