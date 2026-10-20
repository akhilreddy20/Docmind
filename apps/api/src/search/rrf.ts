export interface RankedList {
  ids: string[]; // ordered best-first
  weight: number;
}

/**
 * Reciprocal Rank Fusion: score(d) = sum_i w_i / (k + rank_i(d)).
 * Rank-based, so it fuses BM25 scores and cosine similarities without needing
 * to calibrate their very different scales.
 */
export function reciprocalRankFusion(lists: RankedList[], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { ids, weight } of lists) {
    ids.forEach((id, idx) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + idx + 1));
    });
  }
  return scores;
}
