import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { config } from '../config';
import { RedisService } from '../common/redis.service';
import { CacheScope, CachedAnswer, CachedSource, QueryCacheService } from '../cache/query-cache.service';
import { ChatMessage, LlmService, estimateTokens } from '../llm/llm.service';
import { TokenBucketService } from '../rate-limit/token-bucket.service';
import { HybridSearchService, SearchHit } from '../search/hybrid-search.service';

export interface QueryEvents {
  meta(data: { cache: 'exact' | 'semantic' | 'miss'; similarity?: number; sources: CachedSource[]; retrieval?: unknown }): void;
  token(text: string): void;
  done(data: Record<string, unknown>): void;
}

const SYSTEM_PROMPT = `You are DocuMind, an assistant that answers questions using ONLY the provided document excerpts.
Rules:
- Base every statement on the context. Cite sources inline with their bracketed number, e.g. [2].
- If the answer is not in the context, say you could not find it in the documents. Do not guess.
- Be concise and use markdown (lists, short paragraphs) when it helps readability.`;

const llmBucket = { capacity: config.rateLimit.llmCapacity, refillPerSec: config.rateLimit.llmRefillPerSec };
const reqBucket = { capacity: config.rateLimit.reqCapacity, refillPerSec: config.rateLimit.reqRefillPerSec };

function tooMany(message: string, retryAfterMs: number, extra: Record<string, unknown> = {}) {
  return new HttpException(
    {
      statusCode: 429,
      error: 'Too Many Requests',
      message,
      retryAfterSeconds: retryAfterMs < 0 ? null : Math.ceil(retryAfterMs / 1000),
      ...extra,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

@Injectable()
export class QueryService {
  private readonly logger = new Logger(QueryService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly search: HybridSearchService,
    private readonly cache: QueryCacheService,
    private readonly buckets: TokenBucketService,
    private readonly redis: RedisService,
  ) {}

  async usage(userId: string) {
    const [llm, req] = await Promise.all([
      this.buckets.peek(`llm:${userId}`, llmBucket),
      this.buckets.peek(`req:${userId}`, reqBucket),
    ]);
    return {
      llmTokens: { remaining: llm.remaining, ...llmBucket },
      requests: { remaining: req.remaining, ...reqBucket },
      semanticCacheMode: this.cache.mode,
    };
  }

  async ask(
    userId: string,
    question: string,
    documentIds: string[] | undefined,
    ev: QueryEvents,
    signal: AbortSignal,
  ): Promise<void> {
    const t0 = Date.now();

    // Request-rate bucket: applies to every query, including cache hits.
    const req = await this.buckets.consume(`req:${userId}`, 1, reqBucket);
    if (!req.allowed) throw tooMany('Too many requests, slow down.', req.retryAfterMs);

    const scope: CacheScope = {
      userId,
      corpusVersion: await this.redis.corpusVersion(userId),
      scope: documentIds?.length
        ? createHash('sha1').update([...documentIds].sort().join(',')).digest('hex').slice(0, 16)
        : 'all',
    };

    // 1. Exact cache (no embedding call needed).
    let hit = await this.cache.lookup(scope, question);

    // 2. Embed the question (itself cached), then semantic cache.
    let embedding = await this.cache.getEmbedding(question);
    if (hit.kind === 'miss') {
      if (!embedding) {
        embedding = await this.llm.embedOne(question);
        await this.cache.setEmbedding(question, embedding);
      }
      hit = await this.cache.lookup(scope, question, embedding);
    }

    if (hit.kind !== 'miss') {
      ev.meta({
        cache: hit.kind,
        similarity: hit.kind === 'semantic' ? Number(hit.similarity.toFixed(4)) : undefined,
        sources: hit.value.sources,
      });
      await replay(hit.value.answer, ev, signal);
      ev.done({ cache: hit.kind, matchedQuestion: hit.value.question, totalMs: Date.now() - t0 });
      return;
    }

    // 3. Hybrid retrieval (BM25 + vector, fused with RRF).
    const tRetrieval = Date.now();
    const hits = await this.search.search({ userId, query: question, embedding: embedding!, documentIds });
    const retrievalMs = Date.now() - tRetrieval;
    const sources = hits.map(toSource);

    ev.meta({
      cache: 'miss',
      sources,
      retrieval: hits.map((h) => ({
        index: sources.find((s) => s.documentId === h.documentId && s.chunkIndex === h.chunkIndex)?.index,
        vectorRank: h.vectorRank,
        keywordRank: h.keywordRank,
        similarity: h.similarity === null ? null : Number(h.similarity.toFixed(4)),
        bm25: h.bm25 === null ? null : Number(h.bm25.toFixed(3)),
      })),
    });

    if (hits.length === 0) {
      await replay("I couldn't find anything relevant in your documents. Try uploading more documents or rephrasing.", ev, signal);
      ev.done({ cache: 'miss', retrievalMs, totalMs: Date.now() - t0 });
      return;
    }

    // 4. Reserve LLM tokens up front (worst case), refund the difference afterwards.
    const messages = buildMessages(question, hits);
    const reserved = estimateTokens(messages.map((m) => m.content).join('\n')) + config.llm.maxAnswerTokens;
    const llmGate = await this.buckets.consume(`llm:${userId}`, reserved, llmBucket);
    if (!llmGate.allowed) {
      throw tooMany('LLM token budget exhausted. Please wait before asking again.', llmGate.retryAfterMs, {
        requiredTokens: reserved,
        remainingTokens: llmGate.remaining,
      });
    }

    // 5. Generate and stream.
    const tGen = Date.now();
    let answer = '';
    let usage = { promptTokens: 0, completionTokens: 0 };
    try {
      usage = await this.llm.streamChat(
        messages,
        (t) => {
          answer += t;
          ev.token(t);
        },
        signal,
      );
    } finally {
      const used = usage.promptTokens + usage.completionTokens || estimateTokens(answer);
      await this.buckets.refund(`llm:${userId}`, reserved - used, llmBucket).catch(() => undefined);
    }

    // 6. Cache complete answers only (never partial, aborted ones).
    if (!signal.aborted && answer.trim()) {
      const value: CachedAnswer = { question, answer, sources, createdAt: new Date().toISOString() };
      await this.cache.store(scope, value, embedding!).catch((e) => this.logger.warn(`cache store failed: ${e.message}`));
    }

    ev.done({
      cache: 'miss',
      retrievalMs,
      generationMs: Date.now() - tGen,
      totalMs: Date.now() - t0,
      usage,
    });
  }
}

function toSource(h: SearchHit, i: number): CachedSource {
  return {
    index: i + 1,
    documentId: h.documentId,
    filename: h.filename,
    chunkIndex: h.chunkIndex,
    snippet: h.content.length > 400 ? `${h.content.slice(0, 400)}…` : h.content,
  };
}

export function buildMessages(question: string, hits: SearchHit[]): ChatMessage[] {
  const context = hits
    .map((h, i) => `[${i + 1}] (${h.filename}, chunk ${h.chunkIndex})\n${h.content}`)
    .join('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
  ];
}

/** Stream a cached answer back in word-sized pieces so the client UX is identical to a live answer. */
async function replay(answer: string, ev: QueryEvents, signal: AbortSignal) {
  const parts = answer.match(/\S+\s*/g) ?? [answer];
  for (let i = 0; i < parts.length && !signal.aborted; i += 4) {
    ev.token(parts.slice(i, i + 4).join(''));
    await new Promise((r) => setImmediate(r));
  }
}
