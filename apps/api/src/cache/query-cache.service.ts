import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { config } from '../config';
import { RedisService } from '../common/redis.service';
import { cosineSimilarity, fromFloat32Buffer, normalizeQuery, toFloat32Buffer } from './vector-math';

export interface CachedSource {
  index: number;
  documentId: string;
  filename: string;
  chunkIndex: number;
  snippet: string;
}

export interface CachedAnswer {
  question: string;
  answer: string;
  sources: CachedSource[];
  createdAt: string;
}

export interface CacheScope {
  userId: string;
  corpusVersion: number;
  /** Stable hash of the document filter ("all" when unfiltered). */
  scope: string;
}

export type CacheLookup =
  | { kind: 'exact'; value: CachedAnswer }
  | { kind: 'semantic'; value: CachedAnswer; similarity: number }
  | { kind: 'miss' };

const INDEX = 'idx:semcache';
const SEM_PREFIX = 'semcache:';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const escTag = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '\\$&');

/**
 * Two-tier answer cache.
 *
 * 1. Exact tier: key = hash(normalised question) inside the user's scope. O(1).
 * 2. Semantic tier: stores the question embedding next to the answer. A new
 *    question whose embedding is within SEMANTIC_CACHE_THRESHOLD cosine
 *    similarity of a cached one reuses that answer ("how do I reset my
 *    password" ~ "steps to reset password"). Uses a RediSearch HNSW vector
 *    index when Redis Stack is available, and falls back to a bounded
 *    brute-force scan on plain Redis.
 *
 * Every key embeds the user's corpus version, so uploading or deleting a
 * document atomically invalidates all of that user's cached answers.
 */
@Injectable()
export class QueryCacheService implements OnModuleInit {
  private readonly logger = new Logger(QueryCacheService.name);
  private vectorIndex = false;

  constructor(private readonly redis: RedisService) {}

  get mode() {
    return this.vectorIndex ? 'redisearch' : 'bruteforce';
  }

  async onModuleInit() {
    if (!config.cache.enabled || !config.cache.semanticEnabled) return;
    try {
      await this.redis.client.call(
        'FT.CREATE', INDEX, 'ON', 'HASH', 'PREFIX', '1', SEM_PREFIX,
        'SCHEMA',
        'owner', 'TAG',
        'scope', 'TAG',
        'ver', 'TAG',
        'embedding', 'VECTOR', 'HNSW', '6',
        'TYPE', 'FLOAT32', 'DIM', String(config.llm.embeddingDim), 'DISTANCE_METRIC', 'COSINE',
      );
      this.vectorIndex = true;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/already exists/i.test(msg)) this.vectorIndex = true;
      else this.logger.warn(`RediSearch unavailable (${msg}); semantic cache uses brute-force fallback`);
    }
    this.logger.log(`Semantic cache mode: ${this.mode}`);
  }

  private exactKey(s: CacheScope, question: string) {
    return `cache:exact:${s.userId}:${s.scope}:v${s.corpusVersion}:${sha(normalizeQuery(question))}`;
  }

  async lookup(s: CacheScope, question: string, embedding?: number[]): Promise<CacheLookup> {
    if (!config.cache.enabled) return { kind: 'miss' };
    const exact = await this.redis.client.get(this.exactKey(s, question));
    if (exact) return { kind: 'exact', value: JSON.parse(exact) };
    if (!embedding || !config.cache.semanticEnabled) return { kind: 'miss' };
    const sem = this.vectorIndex ? await this.semanticSearch(s, embedding) : await this.semanticFallback(s, embedding);
    if (sem && sem.similarity >= config.cache.semanticThreshold) {
      return { kind: 'semantic', value: sem.value, similarity: sem.similarity };
    }
    return { kind: 'miss' };
  }

  async store(s: CacheScope, value: CachedAnswer, embedding: number[]) {
    if (!config.cache.enabled) return;
    const ttl = config.cache.ttlSeconds;
    const payload = JSON.stringify(value);
    const pipe = this.redis.client.multi().set(this.exactKey(s, value.question), payload, 'EX', ttl);

    if (config.cache.semanticEnabled) {
      if (this.vectorIndex) {
        const key = `${SEM_PREFIX}${randomUUID()}`;
        pipe
          .hset(key, {
            owner: s.userId,
            scope: s.scope,
            ver: String(s.corpusVersion),
            embedding: toFloat32Buffer(embedding),
            payload,
          })
          .expire(key, ttl);
      } else {
        const base = `semcache:fb:${s.userId}:${s.scope}:v${s.corpusVersion}`;
        const id = randomUUID();
        const entry = JSON.stringify({ e: toFloat32Buffer(embedding).toString('base64'), p: value });
        pipe
          .hset(`${base}:h`, id, entry)
          .lpush(`${base}:ids`, id)
          .expire(`${base}:h`, ttl)
          .expire(`${base}:ids`, ttl);
      }
    }
    await pipe.exec();
    if (!this.vectorIndex && config.cache.semanticEnabled) await this.trimFallback(s);
  }

  /** KNN-1 query against the RediSearch HNSW index, pre-filtered by owner/scope/version tags. */
  private async semanticSearch(s: CacheScope, embedding: number[]) {
    const filter = `@owner:{${escTag(s.userId)}} @scope:{${escTag(s.scope)}} @ver:{${s.corpusVersion}}`;
    const res = (await this.redis.client.call(
      'FT.SEARCH', INDEX, `(${filter})=>[KNN 1 @embedding $vec AS dist]`,
      'PARAMS', '2', 'vec', toFloat32Buffer(embedding),
      'SORTBY', 'dist', 'RETURN', '2', 'dist', 'payload', 'DIALECT', '2',
    )) as any[];
    if (!res || Number(res[0]) === 0) return null;
    const fields: string[] = res[2];
    const get = (name: string) => fields[fields.indexOf(name) + 1];
    // COSINE distance in RediSearch is 1 - cosine similarity.
    return { similarity: 1 - Number(get('dist')), value: JSON.parse(get('payload')) as CachedAnswer };
  }

  private async semanticFallback(s: CacheScope, embedding: number[]) {
    const base = `semcache:fb:${s.userId}:${s.scope}:v${s.corpusVersion}`;
    const all = await this.redis.client.hgetall(`${base}:h`);
    let best: { similarity: number; value: CachedAnswer } | null = null;
    for (const raw of Object.values(all)) {
      const { e, p } = JSON.parse(raw);
      const sim = cosineSimilarity(embedding, fromFloat32Buffer(Buffer.from(e, 'base64')));
      if (!best || sim > best.similarity) best = { similarity: sim, value: p };
    }
    return best;
  }

  private async trimFallback(s: CacheScope) {
    const base = `semcache:fb:${s.userId}:${s.scope}:v${s.corpusVersion}`;
    const max = config.cache.semanticFallbackMaxEntries;
    const len = await this.redis.client.llen(`${base}:ids`);
    if (len <= max) return;
    const evicted = await this.redis.client.rpop(`${base}:ids`, len - max);
    if (evicted?.length) await this.redis.client.hdel(`${base}:h`, ...evicted);
  }

  // --- Query-embedding cache (corpus independent) -------------------------

  async getEmbedding(text: string): Promise<number[] | null> {
    const buf = await this.redis.client.getBuffer(this.embKey(text));
    return buf ? Array.from(fromFloat32Buffer(buf)) : null;
  }

  async setEmbedding(text: string, embedding: number[]) {
    await this.redis.client.set(this.embKey(text), toFloat32Buffer(embedding), 'EX', config.cache.ttlSeconds);
  }

  private embKey(text: string) {
    return `emb:${config.llm.embeddingModel}:${config.llm.embeddingDim}:${sha(normalizeQuery(text))}`;
  }
}
