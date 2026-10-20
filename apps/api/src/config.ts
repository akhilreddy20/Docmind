import 'dotenv/config';

/**
 * Centralised, typed configuration. Every tunable lives here so the API and the
 * worker processes read exactly the same values from the environment.
 */
function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var ${name}`);
  return v;
}
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  return n;
}
function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const mockLlm = bool('MOCK_LLM', false);

export const config = {
  port: num('PORT', 4000),
  corsOrigin: str('CORS_ORIGIN', 'http://localhost:3000'),
  databaseUrl: str('DATABASE_URL', 'postgres://documind:documind@localhost:5432/documind'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret: str('JWT_SECRET', 'dev-only-change-me'),
  jwtExpiresIn: str('JWT_EXPIRES_IN', '7d'),
  maxUploadMb: num('MAX_UPLOAD_MB', 25),

  llm: {
    mock: mockLlm,
    openaiApiKey: mockLlm ? process.env.OPENAI_API_KEY ?? '' : str('OPENAI_API_KEY'),
    chatModel: str('CHAT_MODEL', 'gpt-4o-mini'),
    embeddingModel: str('EMBEDDING_MODEL', 'text-embedding-3-small'),
    embeddingDim: num('EMBEDDING_DIM', 1536),
    maxAnswerTokens: num('MAX_ANSWER_TOKENS', 800),
    temperature: num('TEMPERATURE', 0.2),
  },

  ingestion: {
    queueName: 'ingestion',
    chunkTokens: num('CHUNK_TOKENS', 450),
    chunkOverlapTokens: num('CHUNK_OVERLAP_TOKENS', 60),
    embedBatchSize: num('EMBED_BATCH_SIZE', 64),
    workerConcurrency: num('WORKER_CONCURRENCY', 4),
    // Global (cross-worker) limiter on jobs started per window, protects the embeddings API.
    limiterMax: num('INGEST_LIMITER_MAX', 50),
    limiterDurationMs: num('INGEST_LIMITER_DURATION_MS', 1000),
    attempts: num('INGEST_ATTEMPTS', 3),
  },

  retrieval: {
    topK: num('RETRIEVAL_TOP_K', 6),
    candidateK: num('RETRIEVAL_CANDIDATE_K', 30),
    rrfK: num('RRF_K', 60),
    bm25K1: num('BM25_K1', 1.2),
    bm25B: num('BM25_B', 0.75),
    // Relative weights applied inside Reciprocal Rank Fusion.
    vectorWeight: num('HYBRID_VECTOR_WEIGHT', 1.0),
    keywordWeight: num('HYBRID_KEYWORD_WEIGHT', 1.0),
    hnswEfSearch: num('HNSW_EF_SEARCH', 100),
  },

  cache: {
    enabled: bool('CACHE_ENABLED', true),
    ttlSeconds: num('CACHE_TTL_SECONDS', 60 * 60 * 24),
    semanticEnabled: bool('SEMANTIC_CACHE_ENABLED', true),
    semanticThreshold: num('SEMANTIC_CACHE_THRESHOLD', 0.92),
    // Only used by the brute-force fallback when RediSearch is unavailable.
    semanticFallbackMaxEntries: num('SEMANTIC_CACHE_FALLBACK_MAX', 500),
  },

  rateLimit: {
    // Bucket measured in LLM tokens (prompt + completion).
    llmCapacity: num('RATE_LIMIT_LLM_CAPACITY', 20000),
    llmRefillPerSec: num('RATE_LIMIT_LLM_REFILL_PER_SEC', 50),
    // Bucket measured in requests; guards every query including cache hits.
    reqCapacity: num('RATE_LIMIT_REQ_CAPACITY', 30),
    reqRefillPerSec: num('RATE_LIMIT_REQ_REFILL_PER_SEC', 0.5),
  },
};

export type AppConfig = typeof config;
