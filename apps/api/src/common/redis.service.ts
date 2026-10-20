import { Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';
import { config } from '../config';

/**
 * Shared Redis client for caching and rate limiting. BullMQ gets its own
 * connections (see bullmqConnection) because workers use blocking commands.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: 3 });

  /** Monotonic per-user corpus version; bumped whenever the user's documents change. */
  async corpusVersion(userId: string): Promise<number> {
    const v = await this.client.get(corpusKey(userId));
    return v ? Number(v) : 0;
  }

  async bumpCorpusVersion(userId: string): Promise<number> {
    return this.client.incr(corpusKey(userId));
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => undefined);
  }
}

const corpusKey = (userId: string) => `corpus:ver:${userId}`;

export function bullmqConnection() {
  // BullMQ requires maxRetriesPerRequest = null for blocking worker connections.
  return new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
}
