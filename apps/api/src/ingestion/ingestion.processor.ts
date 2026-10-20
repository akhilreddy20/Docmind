import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { hostname } from 'os';
import { config } from '../config';
import { DatabaseService, toVectorLiteral } from '../common/database.service';
import { RedisService, bullmqConnection } from '../common/redis.service';
import { LlmService } from '../llm/llm.service';
import { chunkText, termCount } from './chunker';
import { IngestJobData } from './ingestion.constants';
import { extractText } from './parser';

const INSERT_BATCH = 100;

/**
 * Consumer side of the ingestion pipeline. Runs in the separate worker process
 * (src/worker.main.ts). Any number of worker replicas can run in parallel: each
 * pulls jobs atomically from the shared BullMQ queue, so throughput scales with
 * replicas x WORKER_CONCURRENCY while per-document latency stays flat.
 */
@Injectable()
export class IngestionProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(`${IngestionProcessor.name}@${hostname()}`);
  private worker: Worker<IngestJobData>;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly llm: LlmService,
  ) {}

  onModuleInit() {
    this.worker = new Worker<IngestJobData>(config.ingestion.queueName, (job) => this.process(job), {
      connection: bullmqConnection(),
      concurrency: config.ingestion.workerConcurrency,
      limiter: { max: config.ingestion.limiterMax, duration: config.ingestion.limiterDurationMs },
    });
    this.worker.on('completed', (job) => this.logger.log(`Job ${job.id} completed`));
    this.worker.on('failed', (job, err) => this.onFailed(job, err));
    this.worker.on('error', (err) => this.logger.error(`Worker error: ${err.message}`));
    this.logger.log(`Ingestion worker started (concurrency=${config.ingestion.workerConcurrency})`);
  }

  async process(job: Job<IngestJobData>) {
    const { documentId, userId } = job.data;
    const started = Date.now();
    const doc = await this.db.one<{ filename: string }>(
      `UPDATE documents SET status = 'processing', progress = 0, error = NULL, updated_at = now()
       WHERE id = $1 RETURNING filename`,
      [documentId],
    );
    if (!doc) throw new UnrecoverableError(`Document ${documentId} no longer exists`);

    const file = await this.db.one<{ data: Buffer }>(`SELECT data FROM document_files WHERE document_id = $1`, [
      documentId,
    ]);
    if (!file) throw new UnrecoverableError('Uploaded file content is missing');

    // 1. Parse
    const text = await extractText(doc.filename, file.data);
    // 2. Chunk
    const chunks = chunkText(text, {
      maxTokens: config.ingestion.chunkTokens,
      overlapTokens: config.ingestion.chunkOverlapTokens,
    });
    if (chunks.length === 0) throw new UnrecoverableError('No extractable text found in document');
    await this.setProgress(job, documentId, 10);

    // 3. Embed in batches
    const embeddings: number[][] = [];
    const batch = config.ingestion.embedBatchSize;
    for (let i = 0; i < chunks.length; i += batch) {
      embeddings.push(...(await this.llm.embed(chunks.slice(i, i + batch))));
      await this.setProgress(job, documentId, 10 + Math.round((80 * Math.min(i + batch, chunks.length)) / chunks.length));
    }

    // 4. Persist atomically. Deleting first makes retries / re-indexing idempotent.
    await this.db.transaction(async (client) => {
      await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId]);
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        const slice = chunks.slice(i, i + INSERT_BATCH);
        const values: unknown[] = [];
        const rows = slice.map((content, j) => {
          const idx = i + j;
          values.push(documentId, userId, idx, content, termCount(content), toVectorLiteral(embeddings[idx]));
          const b = j * 6;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::vector)`;
        });
        await client.query(
          `INSERT INTO chunks (document_id, user_id, chunk_index, content, token_len, embedding) VALUES ${rows.join(',')}`,
          values,
        );
      }
      await client.query(
        `UPDATE documents SET status = 'ready', progress = 100, chunk_count = $2, updated_at = now() WHERE id = $1`,
        [documentId, chunks.length],
      );
    });

    // 5. Invalidate this user's answer caches: their corpus changed.
    await this.redis.bumpCorpusVersion(userId);
    await job.updateProgress(100);
    this.logger.log(`Indexed ${doc.filename}: ${chunks.length} chunks in ${Date.now() - started}ms`);
    return { chunks: chunks.length };
  }

  private async setProgress(job: Job, documentId: string, pct: number) {
    await job.updateProgress(pct);
    await this.db.query(`UPDATE documents SET progress = $2, updated_at = now() WHERE id = $1`, [documentId, pct]);
  }

  private async onFailed(job: Job<IngestJobData> | undefined, err: Error) {
    if (!job) return;
    const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    this.logger.warn(`Job ${job.id} failed (attempt ${job.attemptsMade}, final=${final}): ${err.message}`);
    await this.db
      .query(
        final
          ? `UPDATE documents SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`
          : `UPDATE documents SET status = 'queued', error = $2, updated_at = now() WHERE id = $1`,
        [job.data.documentId, err.message.slice(0, 500)],
      )
      .catch(() => undefined);
  }

  async onModuleDestroy() {
    // Graceful: finish in-flight jobs before exiting so nothing is half-indexed.
    await this.worker?.close();
  }
}
