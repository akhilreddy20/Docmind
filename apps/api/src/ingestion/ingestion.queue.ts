import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { config } from '../config';
import { bullmqConnection } from '../common/redis.service';
import { INGEST_JOB, IngestJobData } from './ingestion.constants';

/** Producer side of the ingestion pipeline. The API only enqueues; workers do the heavy lifting. */
@Injectable()
export class IngestionQueue implements OnModuleDestroy {
  readonly queue = new Queue<IngestJobData>(config.ingestion.queueName, {
    connection: bullmqConnection(),
    defaultJobOptions: {
      attempts: config.ingestion.attempts,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });

  async enqueue(data: IngestJobData) {
    // Remove a finished job with the same id so re-indexing can reuse the deterministic jobId.
    const existing = await this.queue.getJob(data.documentId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') await existing.remove();
      else return existing; // already queued / running: dedupe
    }
    return this.queue.add(INGEST_JOB, data, { jobId: data.documentId });
  }

  async cancel(documentId: string) {
    const job = await this.queue.getJob(documentId);
    if (!job) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') await job.remove();
  }

  async stats() {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
    const workers = await this.queue.getWorkersCount();
    return { ...counts, workers };
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
