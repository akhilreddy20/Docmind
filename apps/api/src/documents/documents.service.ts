import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database.service';
import { RedisService } from '../common/redis.service';
import { IngestionQueue } from '../ingestion/ingestion.queue';
import { SUPPORTED_EXTENSIONS, isSupported } from '../ingestion/parser';

const DOC_COLUMNS = `id, filename, mime_type AS "mimeType", size_bytes AS "sizeBytes", status, progress, error,
  chunk_count AS "chunkCount", created_at AS "createdAt", updated_at AS "updatedAt"`;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly queue: IngestionQueue,
  ) {}

  /** Persist uploads and enqueue them. Returns immediately: parsing/embedding happen in workers. */
  async upload(userId: string, files: Express.Multer.File[]) {
    if (!files?.length) throw new BadRequestException('No files uploaded');
    const bad = files.filter((f) => !isSupported(f.originalname));
    if (bad.length) {
      throw new BadRequestException(
        `Unsupported file type: ${bad.map((f) => f.originalname).join(', ')}. Supported: ${SUPPORTED_EXTENSIONS.join(' ')}`,
      );
    }
    const created = [];
    for (const f of files) {
      const filename = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const doc = await this.db.transaction(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO documents (user_id, filename, mime_type, size_bytes) VALUES ($1, $2, $3, $4) RETURNING ${DOC_COLUMNS}`,
          [userId, filename, f.mimetype || 'application/octet-stream', f.size],
        );
        await c.query(`INSERT INTO document_files (document_id, data) VALUES ($1, $2)`, [rows[0].id, f.buffer]);
        return rows[0];
      });
      await this.queue.enqueue({ documentId: doc.id, userId });
      created.push(doc);
    }
    return created;
  }

  list(userId: string) {
    return this.db.query(`SELECT ${DOC_COLUMNS} FROM documents WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  }

  async get(userId: string, id: string) {
    const doc = await this.db.one(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async remove(userId: string, id: string) {
    await this.get(userId, id);
    await this.queue.cancel(id);
    await this.db.query(`DELETE FROM documents WHERE id = $1 AND user_id = $2`, [id, userId]);
    await this.redis.bumpCorpusVersion(userId);
    return { deleted: true };
  }

  async reindex(userId: string, id: string) {
    await this.get(userId, id);
    await this.db.query(
      `UPDATE documents SET status = 'queued', progress = 0, error = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
    await this.queue.enqueue({ documentId: id, userId });
    return this.get(userId, id);
  }

  async chunks(userId: string, id: string) {
    await this.get(userId, id);
    return this.db.query(
      `SELECT id, chunk_index AS "chunkIndex", content FROM chunks WHERE document_id = $1 ORDER BY chunk_index LIMIT 500`,
      [id],
    );
  }
}
