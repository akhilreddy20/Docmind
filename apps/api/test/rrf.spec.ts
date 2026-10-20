import { reciprocalRankFusion } from '../src/search/rrf';

describe('reciprocalRankFusion', () => {
  it('rewards documents ranked well by both retrievers', () => {
    const scores = reciprocalRankFusion(
      [
        { ids: ['a', 'b', 'c'], weight: 1 },
        { ids: ['d', 'b', 'e'], weight: 1 },
      ],
      60,
    );
    const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(ranked[0]).toBe('b'); // 2nd in both lists beats 1st in only one
    expect(ranked).toContain('d');
  });

  it('surfaces keyword-only hits (e.g. exact IDs) that vector search misses', () => {
    const scores = reciprocalRankFusion([
      { ids: ['v1', 'v2', 'v3'], weight: 1 },
      { ids: ['id-match'], weight: 1 },
    ]);
    const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(ranked.indexOf('id-match')).toBeLessThanOrEqual(1);
  });

  it('applies weights', () => {
    const s = reciprocalRankFusion([
      { ids: ['a'], weight: 2 },
      { ids: ['b'], weight: 1 },
    ]);
    expect(s.get('a')!).toBeCloseTo(2 * s.get('b')!);
  });
});
