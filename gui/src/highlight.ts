// docs/adr/0026: the search terms marked in the conversation, compared like the search
// (ASCII case ignored), with overlapping and adjacent matches merged.
export type HighlightPart = { text: string; hit: boolean };

export const searchTerms = (query: string): string[] => query.split(/\s+/).filter((t) => t !== "");

const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// [start, end) ranges of every match of every term, in UTF-16 units.
const matches = (text: string, terms: readonly string[]): [number, number][] => {
  const hay = lowerAscii(text);
  return terms
    .map(lowerAscii)
    .filter((t) => t !== "")
    .flatMap((t) => {
      const found: [number, number][] = [];
      for (let i = hay.indexOf(t); i >= 0; i = hay.indexOf(t, i + 1)) found.push([i, i + t.length]);
      return found;
    })
    .toSorted((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((acc, [s, e]) => {
      const last = acc[acc.length - 1];
      return last && s <= last[1] ? [...acc.slice(0, -1), [last[0], Math.max(last[1], e)]] : [...acc, [s, e]];
    }, []);
};

export const highlightParts = (text: string, terms: readonly string[]): HighlightPart[] => {
  const [pos, parts] = matches(text, terms).reduce<[number, HighlightPart[]]>(
    ([p, acc], [s, e]) => [e, [...acc, { text: text.slice(p, s), hit: false }, { text: text.slice(s, e), hit: true }]],
    [0, []],
  );
  return [...parts, { text: text.slice(pos), hit: false }].filter((part) => part.text !== "");
};
