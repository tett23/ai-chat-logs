// docs/adr/0014: which messages of a long session to load, a page at a time.
export const PAGE_SIZE = 100;
const BEFORE_HIT = 50;

export type Range = { from: number; to: number };

// The first page: from the start, or around the hit opened from a search.
export const initialRange = (target: number | null, total: number): Range | null => {
  if (total === 0) return null;
  const from = target === null ? 1 : Math.max(1, target - BEFORE_HIT);
  return { from, to: Math.min(total, from + PAGE_SIZE - 1) };
};

export const nextRange = (loaded: Range, total: number): Range | null =>
  loaded.to >= total ? null : { from: loaded.to + 1, to: Math.min(total, loaded.to + PAGE_SIZE) };

export const prevRange = (loaded: Range): Range | null =>
  loaded.from <= 1 ? null : { from: Math.max(1, loaded.from - PAGE_SIZE), to: loaded.from - 1 };
