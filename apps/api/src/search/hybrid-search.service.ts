import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { config } from '../config';
import { DatabaseService, toVectorLiteral } from '../common/database.service';
import { reciprocalRankFusion } from './rrf';

export interface SearchHit {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  score: number; // fused RRF score
  vectorRank: number | null;
  keywordRank: number | null;
  similarity: number | null;
  bm25: number | null;
}

export interface SearchOptions {
  userId: string;
  query: string;
  embedding: number[];
  documentIds?: string[];
  topK?: number;
}

@Injectable()
export class HybridSearchService implements OnModuleInit {
  private readonly logger = new Logger(HybridSearchService.name);
  private iterativeScan = false;

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit() {
    // pgvector >= 0.8 can keep scanning the HNSW graph when a WHERE filter
    // (here: user_id) removes candidates, avoiding under-filled results.
    const row = await this.db.one<{ v: string }>(`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`);
    const [maj, min] = (row?.v ?? '0.0').split('.').map(Number);
    this.iterativeScan = maj > 0 || min >= 8;
    this.logger.log(`pgvector ${row?.v} (iterative scan: ${this.iterativeScan})`);
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const { candidateK, rrfK, vectorWeight, keywordWeight } = config.retrieval;
    const topK = opts.topK ?? config.retrieval.topK;

    const [vector, keyword] = await Promise.all([
      this.vectorSearch(opts, candidateK),
      this.bm25Search(opts, candidateK),
    ]);

    const fused = reciprocalRankFusion(
      [
        { ids: vector.map((r) => r.id), weight: vectorWeight },
        { ids: keyword.map((r) => r.id), weight: keywordWeight },
      ],
      rrfK,
    );
    const top = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
    if (top.length === 0) return [];

    const vecIdx = new Map(vector.map((r, i) => [r.id, { rank: i + 1, score: r.score }]));
    const kwIdx = new Map(keyword.map((r, i) => [r.id, { rank: i + 1, score: r.score }]));
    const rows = await this.db.query<{ id: string; document_id: string; filename: string; chunk_index: number; content: string }>(
      `SELECT c.id::text, c.document_id, d.filename, c.chunk_index, c.content
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.id = ANY($1::bigint[])`,
      [top.map(([id]) => id)],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    return top
      .filter(([id]) => byId.has(id))
      .map(([id, score]) => {
        const r = byId.get(id)!;
        return {
          chunkId: id,
          documentId: r.document_id,
          filename: r.filename,
          chunkIndex: r.chunk_index,
          content: r.content,
          score,
          vectorRank: vecIdx.get(id)?.rank ?? null,
          keywordRank: kwIdx.get(id)?.rank ?? null,
          similarity: vecIdx.get(id)?.score ?? null,
          bm25: kwIdx.get(id)?.score ?? null,
        };
      });
  }

  /** Approximate nearest neighbours by cosine distance using the HNSW index. */
  async vectorSearch(opts: SearchOptions, k: number): Promise<{ id: string; score: number }[]> {
    const params: unknown[] = [opts.userId, toVectorLiteral(opts.embedding), k];
    const docFilter = opts.documentIds?.length ? `AND document_id = ANY($4::uuid[])` : '';
    if (docFilter) params.push(opts.documentIds);

    return this.db.transaction(async (c) => {
      await c.query(`SET LOCAL hnsw.ef_search = ${Math.max(k, Math.floor(config.retrieval.hnswEfSearch))}`);
      if (this.iterativeScan) await c.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      const { rows } = await c.query(
        `SELECT id::text AS id, 1 - (embedding <=> $2::vector) AS score
           FROM chunks
          WHERE user_id = $1 ${docFilter}
          ORDER BY embedding <=> $2::vector
          LIMIT $3`,
        params,
      );
      // relaxed_order may return slightly out-of-order rows; re-sort.
      return rows.map((r) => ({ id: r.id, score: Number(r.score) })).sort((a, b) => b.score - a.score);
    });
  }

  /**
   * Okapi BM25 computed in SQL on top of Postgres full-text search.
   *  - Candidates come from the GIN-indexed tsvector (fast boolean OR match).
   *  - Term frequencies come from tsvector positions, document frequencies are
   *    counted per query term over the user's corpus, and length normalisation
   *    uses each chunk's stored term count vs. the corpus average.
   * Unlike ts_rank, this gives proper IDF weighting, so rare exact terms such as
   * names, error codes or IDs dominate the ranking the way users expect.
   */
  async bm25Search(opts: SearchOptions, k: number): Promise<{ id: string; score: number }[]> {
    const { bm25K1: k1, bm25B: b } = config.retrieval;
    const params: unknown[] = [opts.userId, opts.query, k, k1, b];
    const docFilter = opts.documentIds?.length ? `AND c.document_id = ANY($6::uuid[])` : '';
    if (docFilter) params.push(opts.documentIds);

    const rows = await this.db.query<{ id: string; score: string }>(
      `WITH q AS (
         SELECT DISTINCT u.lexeme AS term FROM unnest(to_tsvector('english', $2)) AS u
       ),
       qry AS (
         SELECT to_tsquery('simple', string_agg(quote_literal(term), ' | ')) AS tsq FROM q
       ),
       stats AS (
         SELECT count(*)::float8 AS n, greatest(coalesce(avg(token_len), 1), 1)::float8 AS avgdl
           FROM chunks c WHERE c.user_id = $1 ${docFilter}
       ),
       df AS (
         SELECT q.term,
                (SELECT count(*) FROM chunks c
                  WHERE c.user_id = $1 ${docFilter}
                    AND c.tsv @@ to_tsquery('simple', quote_literal(q.term)))::float8 AS df
           FROM q
       ),
       cand AS (
         SELECT c.id, c.tsv, c.token_len
           FROM chunks c, qry
          WHERE c.user_id = $1 ${docFilter} AND c.tsv @@ qry.tsq
          ORDER BY ts_rank_cd(c.tsv, qry.tsq) DESC
          LIMIT 1000
       )
       SELECT cand.id::text AS id,
              sum(
                ln(1 + (s.n - df.df + 0.5) / (df.df + 0.5)) *
                (tf.f * ($4::float8 + 1)) /
                (tf.f + $4::float8 * (1 - $5::float8 + $5::float8 * cand.token_len / s.avgdl))
              ) AS score
         FROM cand
         CROSS JOIN stats s
         CROSS JOIN LATERAL (
           SELECT u.lexeme, coalesce(array_length(u.positions, 1), 1)::float8 AS f
             FROM unnest(cand.tsv) AS u
         ) tf
         JOIN df ON df.term = tf.lexeme
        GROUP BY cand.id
        ORDER BY score DESC
        LIMIT $3`,
      params,
    );
    return rows.map((r) => ({ id: r.id, score: Number(r.score) }));
  }
}
