import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis.service';

/**
 * Atomic token bucket in a single Lua script. Using Redis server TIME means
 * all API replicas share one clock and one bucket per user, so limits hold
 * under horizontal scaling and concurrent bursts (no read-modify-write race).
 *
 * KEYS[1] bucket key
 * ARGV[1] capacity, ARGV[2] refill tokens/sec, ARGV[3] cost (may be negative = refund)
 * Returns {allowed(0|1), remaining, retryAfterMs}
 */
const SCRIPT = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * rate / 1000)

local allowed = 0
local retry = 0
if cost <= tokens then
  tokens = math.min(capacity, tokens - cost)
  allowed = 1
else
  retry = math.ceil((cost - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)
return {allowed, math.floor(tokens), retry}
`;

export interface BucketResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface BucketConfig {
  capacity: number;
  refillPerSec: number;
}

@Injectable()
export class TokenBucketService {
  constructor(private readonly redis: RedisService) {
    this.redis.client.defineCommand('tokenBucket', { numberOfKeys: 1, lua: SCRIPT });
  }

  async consume(key: string, cost: number, cfg: BucketConfig): Promise<BucketResult> {
    if (cost > cfg.capacity) {
      // Can never succeed; fail fast rather than telling the client to wait forever.
      return { allowed: false, remaining: 0, retryAfterMs: -1 };
    }
    const [allowed, remaining, retry] = (await (this.redis.client as any).tokenBucket(
      `ratelimit:${key}`,
      cfg.capacity,
      cfg.refillPerSec,
      cost,
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs: retry };
  }

  /** Return unused tokens (e.g. when actual LLM usage was below the reservation). */
  async refund(key: string, amount: number, cfg: BucketConfig) {
    if (amount <= 0) return;
    await (this.redis.client as any).tokenBucket(`ratelimit:${key}`, cfg.capacity, cfg.refillPerSec, -amount);
  }

  async peek(key: string, cfg: BucketConfig) {
    return this.consume(key, 0, cfg);
  }
}
