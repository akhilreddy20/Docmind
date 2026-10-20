export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function toFloat32Buffer(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

export function fromFloat32Buffer(buf: Buffer): Float32Array {
  // Copy into an aligned buffer: Buffer slices may not be 4-byte aligned.
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

/** Normalise a question so trivially different phrasings share an exact-cache key. */
export function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[\s?.!]+$/g, '')
    .trim();
}
