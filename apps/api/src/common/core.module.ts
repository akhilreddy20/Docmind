import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { RedisService } from './redis.service';
import { LlmService } from '../llm/llm.service';

@Global()
@Module({
  providers: [DatabaseService, RedisService, LlmService],
  exports: [DatabaseService, RedisService, LlmService],
})
export class CoreModule {}
