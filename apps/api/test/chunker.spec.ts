import { chunkText, normalizeText, termCount } from '../src/ingestion/chunker';
import { estimateTokens } from '../src/llm/llm.service';

describe('chunker', () => {
  const para = (n: number) =>
    Array.from({ length: n }, (_, i) => `Sentence number ${i} talks about topic ${i % 7} in some detail.`).join(' ');

  it('returns no chunks for empty text', () => {
    expect(chunkText('   \n\n ', { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });

  it('keeps small documents in a single chunk', () => {
    expect(chunkText('Hello world. This is short.', { maxTokens: 100, overlapTokens: 10 })).toHaveLength(1);
  });

  it('respects the max token budget', () => {
    const chunks = chunkText(para(200), { maxTokens: 80, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(85);
  });

  it('overlaps consecutive chunks', () => {
    const chunks = chunkText(para(60), { maxTokens: 60, overlapTokens: 20 });
    const lastSentenceOfFirst = chunks[0].split(/(?<=\.)\s+/).pop()!;
    expect(chunks[1].startsWith(lastSentenceOfFirst)).toBe(true);
  });

  it('hard-splits a single giant sentence', () => {
    const giant = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkText(giant, { maxTokens: 100, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.join(' ').split(/\s+/)).toHaveLength(2000);
  });

  it('normalises whitespace', () => {
    expect(normalizeText('a  \t b\r\n\n\n\nc')).toBe('a b\n\nc');
  });

  it('counts terms', () => {
    expect(termCount('ERR-5003: upstream timeout (30s)')).toBe(5);
  });
});
