// docs/adr/0014, docs/adr/0016: which messages of a long session to load, a page at a time,
// shown newest first.
export const PAGE_SIZE = 100;
const BEFORE_HIT = 50;

export type Range = { from: number; to: number };

// The first page: the newest messages, or around the hit opened from a search.
export const initialRange = (target: number | null, total: number): Range | null => {
  if (total === 0) return null;
  const from = target === null ? Math.max(1, total - PAGE_SIZE + 1) : Math.max(1, target - BEFORE_HIT);
  return { from, to: Math.min(total, from + PAGE_SIZE - 1) };
};

// Older messages, shown below the loaded ones.
export const olderRange = (loaded: Range): Range | null =>
  loaded.from <= 1 ? null : { from: Math.max(1, loaded.from - PAGE_SIZE), to: loaded.from - 1 };

// Newer messages, shown above the loaded ones.
export const newerRange = (loaded: Range, total: number): Range | null =>
  loaded.to >= total ? null : { from: loaded.to + 1, to: Math.min(total, loaded.to + PAGE_SIZE) };

export const newestFirst = <T extends { index: number }>(messages: readonly T[]): T[] =>
  messages.toSorted((a, b) => b.index - a.index);
