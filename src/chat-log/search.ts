// docs/adr/0011: the search rules of the GUI (docs/adr/0003, docs/adr/0005, gui/src-tauri/src/query.rs) in TypeScript.

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

// docs/adr/0018: a window of `context` characters on each side of the first occurrence of each
// term, merged where they overlap or touch and widened so that no occurrence is cut, joined with
// "…". Without any occurrence, the head of the text.
export const makeSnippet = (text: string, terms: readonly string[], context: number): string => {
  const hay = [...text];
  const needles = terms.map((t) => [...t]).filter((t) => t.length > 0);
  const hits = occurrences(hay, needles);
  const firsts = needles.flatMap((n) => occurrences(hay, [n]).slice(0, 1));
  const widen = ([start, end]: [number, number]): [number, number] =>
    hits.reduce<[number, number]>(([s, e], [hs, he]) => (hs < e && he > s ? [Math.min(s, hs), Math.max(e, he)] : [s, e]), [start, end]);
  const windows = (firsts.length > 0 ? firsts.map(([s, e]): [number, number] => [Math.max(0, s - context), Math.min(hay.length, e + context)]) : [[0, Math.min(hay.length, context * 2)] as [number, number]])
    .map(widen)
    .toSorted((x, y) => x[0] - y[0])
    .reduce<[number, number][]>((acc, w) => {
      const last = acc[acc.length - 1];
      return last && w[0] <= last[1] ? [...acc.slice(0, -1), [last[0], Math.max(last[1], w[1])]] : [...acc, w];
    }, []);
  const body = ([start, end]: [number, number]): string => {
    const [pos, runs] = hits
      .filter(([s, e]) => s >= start && e <= end)
      .reduce<[number, Run[]]>(
        ([p, acc], [s, e]) => [e, [...acc, { text: hay.slice(p, s).join(""), hit: false }, { text: hay.slice(s, e).join(""), hit: true }]],
        [start, []],
      );
    return render([...runs, { text: hay.slice(pos, end).join(""), hit: false }]);
  };
  const first = windows[0] as [number, number];
  const last = windows[windows.length - 1] as [number, number];
  return `${first[0] > 0 ? "…" : ""}${windows.map(body).join("…")}${last[1] < hay.length ? "…" : ""}`;
};
