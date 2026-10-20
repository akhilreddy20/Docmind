import { estimateTokens } from '../llm/llm.service';

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
}

/** Collapse whitespace noise produced by PDF/DOCX extraction while keeping paragraph breaks. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split text into "units" that should not be broken: sentences inside
 * paragraphs. Any unit that is still larger than maxTokens is hard-split on
 * word boundaries.
 */
function toUnits(text: string, maxTokens: number): string[] {
  const units: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    const sentences = p.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])|\n/);
    sentences.forEach((s, i) => {
      const sentence = s.trim();
      if (!sentence) return;
      const isParaEnd = i === sentences.length - 1;
      if (estimateTokens(sentence) <= maxTokens) {
        units.push(sentence + (isParaEnd ? '\n\n' : ' '));
        return;
      }
      // Hard-split an oversize sentence (e.g. tables or minified text).
      const words = sentence.split(/\s+/);
      let buf: string[] = [];
      for (const w of words) {
        if (estimateTokens([...buf, w].join(' ')) > maxTokens && buf.length) {
          units.push(buf.join(' ') + ' ');
          buf = [];
        }
        buf.push(w);
      }
      if (buf.length) units.push(buf.join(' ') + (isParaEnd ? '\n\n' : ' '));
    });
  }
  return units;
}

/**
 * Greedy packing of sentence units into chunks of ~maxTokens with a sliding
 * overlap of ~overlapTokens taken from the tail of the previous chunk, so a
 * fact straddling a boundary is retrievable from either side.
 */
export function chunkText(raw: string, opts: ChunkOptions): string[] {
  const text = normalizeText(raw);
  if (!text) return [];
  const units = toUnits(text, opts.maxTokens);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let fresh = 0; // units added since the last flush (excludes carried-over overlap)

  const flush = () => {
    fresh = 0;
    const chunk = current.join('').trim();
    if (chunk) chunks.push(chunk);
    // Seed the next chunk with trailing units up to the overlap budget.
    const overlap: string[] = [];
    let t = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      const ut = estimateTokens(current[i]);
      if (t + ut > opts.overlapTokens) break;
      overlap.unshift(current[i]);
      t += ut;
    }
    current = overlap;
    currentTokens = t;
  };

  for (const unit of units) {
    const ut = estimateTokens(unit);
    if (currentTokens + ut > opts.maxTokens && fresh > 0) flush();
    // If the carried overlap + this unit still doesn't fit, drop the overlap.
    if (currentTokens + ut > opts.maxTokens) {
      current = [];
      currentTokens = 0;
    }
    current.push(unit);
    currentTokens += ut;
    fresh++;
  }
  if (fresh > 0) {
    const last = current.join('').trim();
    if (last) chunks.push(last);
  }
  return chunks;
}

/** Number of word tokens; used as BM25 document length. */
export function termCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}
