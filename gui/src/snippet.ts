// docs/adr/0005: hits in snippets are delimited by private-use characters.
export const HIT_START = "";
export const HIT_END = "";

export type SnippetPart = { text: string; hit: boolean };

// Split a snippet into plain and highlighted parts; the text is never interpreted as HTML.
export const splitSnippet = (snippet: string): SnippetPart[] =>
  snippet
    .split(HIT_START)
    .flatMap((chunk, i) => {
      if (i === 0) return [{ text: chunk, hit: false }];
      const end = chunk.indexOf(HIT_END);
      return end < 0
        ? [{ text: chunk, hit: true }]
        : [
            { text: chunk.slice(0, end), hit: true },
            { text: chunk.slice(end + HIT_END.length), hit: false },
          ];
    })
    .filter((part) => part.text !== "");
