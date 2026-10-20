# DocuMind — Production-Grade RAG Knowledge Assistant

Ask natural-language questions across your own documents (PDF, DOCX, Markdown, TXT, HTML, CSV, JSON) and get streamed, cited answers.

**Stack:** Next.js 15 · NestJS 10 · PostgreSQL 16 + pgvector · Redis (Stack) · BullMQ · OpenAI

```
┌────────────┐   POST /query/stream (SSE)   ┌──────────────────────── NestJS API ───────────────────────┐
│  Next.js   │ ───────────────────────────▶ │ JWT auth → token-bucket limiter → exact cache → embed →   │
│  web app   │ ◀── meta / token / done ──── │ semantic cache → hybrid search (BM25 + vector, RRF) →     │
└─────┬──────┘                              │ LLM stream → cache store                                  │
      │ upload                              └──────┬───────────────────────────┬────────────────────────┘
      ▼                                            │ enqueue job               │ SQL
┌─────────────┐      BullMQ queue (Redis)    ┌─────▼────────────┐       ┌──────▼───────────────────────┐
│ POST        │ ───────────────────────────▶ │ Worker replica 1 │──────▶│ Postgres + pgvector          │
│ /documents  │                              │ Worker replica 2 │ parse │  chunks: HNSW (cosine) index │
└─────────────┘                              │ Worker replica N │ chunk │          GIN tsvector index  │
                                             └──────────────────┘ embed └──────────────────────────────┘
```

## Features → where they live

| Capability | Implementation |
|---|---|
| **Async ingestion pipeline** | `POST /documents` stores the bytes in Postgres and enqueues a BullMQ job, then returns immediately. Parsing, chunking and embedding happen in a separate worker process (`src/worker.main.ts`, `src/ingestion/ingestion.processor.ts`). The API's event loop never parses a PDF. |
| **Horizontal worker scaling** | Workers are stateless. File bytes live in Postgres (`document_files`), not on local disk, so any replica on any host can take any job. Run `docker compose up --scale worker=N`. Throughput grows with replicas × `WORKER_CONCURRENCY`, and per-document latency stays the same. A BullMQ limiter caps the global embedding call rate across all replicas. Jobs retry with exponential backoff and are idempotent: chunks are deleted and re-inserted in one transaction. |
| **Chunking** | Sentence-aware recursive packing with a sliding token overlap (`src/ingestion/chunker.ts`). |
| **Hybrid search** | `src/search/hybrid-search.service.ts` runs two retrievers in parallel: (1) **vector** ANN through the pgvector HNSW index (cosine distance), and (2) **Okapi BM25** computed in SQL. Candidates come from the GIN tsvector index. TF comes from tsvector positions, DF is counted per query term, and length normalisation uses the stored per-chunk term count against the corpus average. The two result lists are merged with **Reciprocal Rank Fusion** (`src/search/rrf.ts`), so exact identifiers like `ERR-5003` or `INV-2024-0042` rank highly even when embeddings miss them. |
| **Redis caching** | `src/cache/query-cache.service.ts`. **Exact tier:** key = SHA-256 of the normalised question. **Semantic tier:** the question embedding is stored with the answer. A new question above `SEMANTIC_CACHE_THRESHOLD` cosine similarity reuses the cached answer. On Redis Stack this uses a **RediSearch HNSW vector index** (KNN-1 pre-filtered by user, scope and corpus version). On plain Redis it falls back to a bounded brute-force scan. Query embeddings are cached too, so a repeated question makes no embedding call. |
| **Cache invalidation** | Every cache key includes a per-user **corpus version** (`corpus:ver:{user}`). The version is bumped when a document finishes indexing or is deleted, which instantly invalidates stale answers without any key scanning. |
| **Token-bucket rate limiter** | `src/rate-limit/token-bucket.service.ts`: an atomic Lua script that uses Redis server `TIME`, so all API replicas share one bucket and one clock. There are two buckets per user. **Requests** applies to every query. **LLM tokens** reserves the worst case (prompt + `MAX_ANSWER_TOKENS`) before calling the LLM, then refunds the unused part based on the real usage OpenAI reports. Cache hits spend no LLM tokens. A denied request returns HTTP 429 with a `Retry-After` header. |
| **Streaming via SSE** | `POST /query/stream` returns `text/event-stream` with these events: `meta` (sources, cache status, retrieval scores), `token`, `done` (timings, usage) and `error`. Headers are sent lazily, so a validation or rate-limit failure still returns a real HTTP status. Proxy buffering is disabled, heartbeats run every 15 s, and the upstream OpenAI request is aborted when the client disconnects. Partial (aborted) answers are never cached. |

## Quick start (Docker)

```bash
cp .env.example .env        # add OPENAI_API_KEY (or set MOCK_LLM=true for offline mode)
docker compose up --build   # web :3000, api :4000, 2 workers
docker compose up --build --scale worker=6   # more ingestion throughput
```

Open http://localhost:3000, create an account, drop in some files (try `samples/`), and ask a question.

`./scripts/smoke-test.sh` runs the whole flow from the command line: register, upload, wait for workers, ask, and confirm the repeat question is a cache hit.

## Local development

```bash
npm run infra:up            # Postgres (pgvector) + Redis Stack via docker-compose.dev.yml
cd apps/api && npm ci && cp ../../.env.example .env
npm run dev                 # API on :4000 (runs migrations on boot)
npm run dev:worker          # in another terminal; start as many as you like
cd ../web && npm ci && npm run dev   # http://localhost:3000
```

**Offline mode:** `MOCK_LLM=true` swaps OpenAI for deterministic hashed bag-of-words embeddings and an extractive "answer". The whole pipeline (ingestion, hybrid search, both cache tiers, rate limiting, SSE) runs with no API key, which is handy for CI and demos.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | `{email, password}` → `{accessToken, user}` |
| GET | `/auth/me` | |
| POST | `/documents` | multipart, field `files` (up to 20, `MAX_UPLOAD_MB` each) → 201 with `status: queued` |
| GET | `/documents` | status, progress, chunk count |
| GET | `/documents/:id` · `/documents/:id/chunks` | |
| POST | `/documents/:id/reindex` | re-runs ingestion (idempotent) |
| DELETE | `/documents/:id` | cascades chunks and invalidates the cache |
| GET | `/documents/queue/stats` | waiting / active / failed jobs and live worker count |
| POST | `/query/stream` | `{question, documentIds?}` → SSE |
| GET | `/query/usage` | remaining rate-limit budget |
| GET | `/health` | DB and Redis status |

```bash
curl -N -X POST localhost:4000/query/stream -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"question":"What does ERR-5003 mean?"}'
# event: meta
# data: {"cache":"miss","sources":[...],"retrieval":[{"vectorRank":1,"keywordRank":1,...}]}
# event: token
# data: "ERR-5003 is an upstream "
# event: done
# data: {"cache":"miss","retrievalMs":12,"generationMs":840,"usage":{...}}
```

## Data model

```sql
documents(id, user_id, filename, status queued|processing|ready|failed, progress, chunk_count, ...)
document_files(document_id, data bytea)        -- shared storage for stateless workers
chunks(id, document_id, user_id, chunk_index, content, token_len,
       tsv tsvector GENERATED (to_tsvector('english', content)),   -- GIN index → BM25
       embedding vector(1536))                                     -- HNSW cosine index
```

Migrations live in `apps/api/src/db/migrations`. They run automatically on boot, and a Postgres advisory lock makes that safe when many replicas start at once.

## Configuration

All settings come from environment variables (see `.env.example` and `apps/api/src/config.ts`). The most important ones:

| Var | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | – | required unless `MOCK_LLM=true` |
| `CHAT_MODEL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | gpt-4o-mini / text-embedding-3-small / 1536 | changing the dimension requires a fresh DB |
| `WORKER_CONCURRENCY` | 4 | jobs in parallel per worker replica |
| `CHUNK_TOKENS` / `CHUNK_OVERLAP_TOKENS` | 450 / 60 | |
| `RETRIEVAL_TOP_K` / `RETRIEVAL_CANDIDATE_K` | 6 / 30 | final context size / per-retriever candidates |
| `HYBRID_VECTOR_WEIGHT` / `HYBRID_KEYWORD_WEIGHT` | 1 / 1 | RRF weights |
| `SEMANTIC_CACHE_THRESHOLD` | 0.92 | cosine similarity needed for a semantic hit |
| `RATE_LIMIT_LLM_CAPACITY` / `_REFILL_PER_SEC` | 20000 / 50 | per-user LLM token bucket |
| `RATE_LIMIT_REQ_CAPACITY` / `_REFILL_PER_SEC` | 30 / 0.5 | per-user request bucket |

## Tests

```bash
cd apps/api && npm test
```

There are unit tests for the chunker, RRF fusion and the vector/cache helpers. There are also integration tests for the token bucket against a real Redis: burst capacity, refunds, and atomicity under 50 concurrent requests. These are skipped when Redis is unavailable.

## Project layout

```
apps/api/src
  main.ts / worker.main.ts      two entrypoints, one codebase and image
  auth/                         JWT register/login + guard
  documents/                    upload, list, delete, reindex
  ingestion/                    BullMQ producer, worker processor, parser, chunker
  search/                       hybrid BM25 + pgvector search, RRF
  cache/                        exact + semantic Redis cache
  rate-limit/                   Redis Lua token bucket
  query/                        RAG orchestration + SSE controller
  llm/                          OpenAI wrapper + offline mock
apps/web                        Next.js App Router UI (upload, live ingest progress, streaming chat, citations, retrieval-score inspector)
samples/                        example documents
```