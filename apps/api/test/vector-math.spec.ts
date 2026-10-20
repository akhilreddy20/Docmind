import { cosineSimilarity, fromFloat32Buffer, normalizeQuery, toFloat32Buffer } from '../src/cache/vector-math';
import { mockEmbedding } from '../src/llm/llm.service';

describe('vector math', () => {
  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('round-trips float32 buffers', () => {
    const v = [0.25, -0.5, 1];
    expect(Array.from(fromFloat32Buffer(toFloat32Buffer(v)))).toEqual(v);
  });

  it('normalises queries for exact-cache keys', () => {
    expect(normalizeQuery('  What is   ERR-5003?? ')).toBe(normalizeQuery('what is err-5003'));
  });

  it('mock embeddings place paraphrases closer than unrelated text', () => {
    const a = mockEmbedding('how do I reset my password', 256);
    const b = mockEmbedding('steps to reset password', 256);
    const c = mockEmbedding('quarterly revenue by region', 256);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });
});
