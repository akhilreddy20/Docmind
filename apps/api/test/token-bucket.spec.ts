/**
 * Integration test: requires a reachable Redis (REDIS_URL, default localhost).
 * Skipped automatically when Redis is not available.
 */
import IORedis from 'ioredis';
import { RedisService } from '../src/common/redis.service';
import { TokenBucketService } from '../src/rate-limit/token-bucket.service';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe('TokenBucketService (redis)', () => {
  let redis: RedisService;
  let svc: TokenBucketService;
  let available = true;
  const key = `test:${Date.now()}`;

  beforeAll(async () => {
    const probe = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    try {
      await probe.connect();
      await probe.ping();
    } catch {
      available = false;
    } finally {
      probe.disconnect();
    }
    if (available) {
      redis = new RedisService();
      svc = new TokenBucketService(redis);
    }
  });

  afterAll(async () => {
    if (available) {
      await redis.client.del(`ratelimit:${key}`);
      await redis.onModuleDestroy();
    }
  });

  const cfg = { capacity: 10, refillPerSec: 1 };

  it('allows bursts up to capacity then rejects', async () => {
    if (!available) return console.warn('Redis unavailable, skipping');
    expect((await svc.consume(key, 6, cfg)).allowed).toBe(true);
    expect((await svc.consume(key, 4, cfg)).allowed).toBe(true);
    const denied = await svc.consume(key, 3, cfg);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(2000);
  });

  it('refunds unused tokens', async () => {
    if (!available) return;
    await svc.refund(key, 5, cfg);
    expect((await svc.consume(key, 5, cfg)).allowed).toBe(true);
  });

  it('is atomic under concurrent bursts', async () => {
    if (!available) return;
    const k2 = `${key}:burst`;
    const results = await Promise.all(Array.from({ length: 50 }, () => svc.consume(k2, 1, { capacity: 20, refillPerSec: 0.001 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    await redis.client.del(`ratelimit:${k2}`);
  });

  it('rejects costs larger than capacity outright', async () => {
    if (!available) return;
    expect(await svc.consume(key, 11, cfg)).toEqual({ allowed: false, remaining: 0, retryAfterMs: -1 });
  });
});
