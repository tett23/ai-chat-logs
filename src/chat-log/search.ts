// docs/adr/0011: the search rules of the GUI (docs/adr/0003, docs/adr/0005, gui/src-tauri/src/query.rs) in TypeScript.

export const HIT_START = "";
export const HIT_END = "";
const MIN_INDEXED_CHARS = 3;

export type SearchPlan = { fts: string | null; likes: string[]; terms: string[] };

const ftsPhrase = (term: string): string => `"${term.replaceAll('"', '""')}"`;
const likePattern = (term: string): string => `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

export const planSearch = (input: string): SearchPlan => {
  const terms = input.split(/\s+/).filter((t) => t !== "");
  const long = terms.filter((t) => [...t].length >= MIN_INDEXED_CHARS);
  const short = terms.filter((t) => [...t].length < MIN_INDEXED_CHARS);
  return { fts: long.length > 0 ? long.map(ftsPhrase).join(" AND ") : null, likes: short.map(likePattern), terms };
};

// docs/adr/0013: hits are marked with ⟪⟫, which the texts do not contain, rather than Markdown's **.
export const MARK_OPEN = "⟪";
export const MARK_CLOSE = "⟫";

type Run = { text: string; hit: boolean };

// Runs with neighbors of the same kind merged, rendered with ⟪⟫ around the hits.
const render = (runs: readonly Run[]): string =>
  runs
    .filter((r) => r.text !== "")
    .reduce<Run[]>((acc, r) => {
      const last = acc[acc.length - 1];
      return last && last.hit === r.hit ? [...acc.slice(0, -1), { text: last.text + r.text, hit: r.hit }] : [...acc, r];
    }, [])
    .map((r) => (r.hit ? `${MARK_OPEN}${r.text}${MARK_CLOSE}` : r.text))
    .join("");

// FTS5's snippet() delimiters (which may nest or touch) to ⟪⟫.
export const highlight = (snippet: string): string => {
  const runs: Run[] = [];
  let depth = 0;
  let text = "";
  for (const c of snippet) {
    if (c === HIT_START || c === HIT_END) {
      runs.push({ text, hit: depth > 0 });
      text = "";
      depth = Math.max(0, depth + (c === HIT_START ? 1 : -1));
    } else {
      text += c;
    }
  }
  runs.push({ text, hit: depth > 0 });
  return render(runs);
};

const sameAscii = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase() || a === b;

// Ranges [start, end) of non-overlapping occurrences of any term (ASCII case-insensitive, like LIKE).
const occurrences = (hay: readonly string[], terms: readonly string[][]): [number, number][] => {
  const find = (needle: readonly string[], from: number): number => {
    for (let i = from; i + needle.length <= hay.length; i++) {
      if (needle.every((c, j) => sameAscii(hay[i + j] as string, c))) return i;
    }
    return -1;
  };
  const result: [number, number][] = [];
  let pos = 0;
  for (;;) {
    const next = terms
      .filter((t) => t.length > 0)
      .map((t): [number, number] => [find(t, pos), t.length])
      .filter(([i]) => i >= 0)
      .sort((a, b) => a[0] - b[0])[0];
    if (next === undefined) return result;
    result.push([next[0], next[0] + next[1]]);
    pos = next[0] + next[1];
  }
};

// A snippet around the first occurrence, for searches without an FTS5 query.
export const makeSnippet = (text: string, terms: readonly string[], context: number): string => {
  const hay = [...text];
  const hits = occurrences(hay, terms.map((t) => [...t]));
  const first = hits[0];
  const start = Math.max(0, (first?.[0] ?? 0) - context);
  const end = Math.min(hay.length, first ? first[1] + context : context * 2);
  const inWindow = hits.filter(([s, e]) => s >= start && e <= end);
  const [pos, runs] = inWindow.reduce<[number, Run[]]>(
    ([p, acc], [s, e]) => [e, [...acc, { text: hay.slice(p, s).join(""), hit: false }, { text: hay.slice(s, e).join(""), hit: true }]],
    [start, []],
  );
  const body = render([...runs, { text: hay.slice(pos, end).join(""), hit: false }]);
  return `${start > 0 ? "…" : ""}${body}${end < hay.length ? "…" : ""}`;
};
