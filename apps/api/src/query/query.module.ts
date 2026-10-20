import { Module } from '@nestjs/common';
import { QueryCacheService } from '../cache/query-cache.service';
import { TokenBucketService } from '../rate-limit/token-bucket.service';
import { HybridSearchService } from '../search/hybrid-search.service';
import { QueryController } from './query.controller';
import { QueryService } from './query.service';

@Module({
  controllers: [QueryController],
  providers: [QueryService, HybridSearchService, QueryCacheService, TokenBucketService],
})
export class QueryModule {}
