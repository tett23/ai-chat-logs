// docs/adr/0003: only ``` fenced blocks are rendered as monospace; everything else is plain text.
export type FencePart = { kind: "text"; text: string } | { kind: "code"; lang: string; text: string };

const FENCE = /^\s*```(.*)$/;

type Segment = { start: number; end: number; lang: string | null };

// Segments of [start, end) line ranges; lang is null for text, the fence language for code.
const segments = (lines: readonly string[]): Segment[] => {
  const result: Segment[] = [];
  let start = 0;
  let lang: string | null = null;
  lines.forEach((line, i) => {
    const fence = FENCE.exec(line);
    if (!fence) return;
    const info = (fence[1] ?? "").trim();
    if (lang === null) {
      result.push({ start, end: i, lang: null });
      start = i + 1;
      lang = info;
    } else if (info === "") {
      // inside code, only a bare ``` closes; ```lang is content (no nesting)
      result.push({ start, end: i, lang });
      start = i + 1;
      lang = null;
    }
  });
  result.push({ start, end: lines.length, lang });
  return result;
};

export const splitFences = (text: string): FencePart[] => {
  const lines = text.split("\n");
  return segments(lines).flatMap(({ start, end, lang }): FencePart[] => {
    const body = lines.slice(start, end).join("\n");
    if (lang !== null) return [{ kind: "code", lang, text: body }];
    return body === "" ? [] : [{ kind: "text", text: body }];
  });
};
