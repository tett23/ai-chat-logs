import { describe, expect, test } from "bun:test";
import { renderBlock, replaceBase64, toBlocks, truncate } from "../src/chat-log/blocks.ts";
import { makeSnippet, planSearch } from "../src/chat-log/search.ts";
import { matchSession, parseTime } from "../src/chat-log/values.ts";

// docs/adr/0011
describe("parseTime", () => {
  const now = Date.parse("2026-10-17T12:00:00.000Z");

  test("relative durations", () => {
    expect(parseTime("7d", now)).toBe("2026-10-10T12:00:00.000Z");
    expect(parseTime("12h", now)).toBe("2026-10-17T00:00:00.000Z");
    expect(parseTime("30m", now)).toBe("2026-10-17T11:30:00.000Z");
  });

  test("ISO 8601 dates and times", () => {
    expect(parseTime("2026-10-01", now)).toBe("2026-10-01T00:00:00.000Z");
    expect(parseTime("2026-10-01T12:00:00+09:00", now)).toBe("2026-10-01T03:00:00.000Z");
  });

  test.each(["", "7", "7w", "yesterday", "2026-13-40"])("rejects %p", (input) => {
    expect(() => parseTime(input, now)).toThrow();
  });
});

describe("planSearch", () => {
  test("quotes long terms for FTS5 and turns short ones into LIKE patterns", () => {
    expect(planSearch("  全文検索  が abc ")).toEqual({
      fts: '"全文検索" AND "abc"',
      likes: ["%が%"],
      terms: ["全文検索", "が", "abc"],
    });
  });

  test("keeps FTS5 syntax literal and escapes LIKE wildcards", () => {
    expect(planSearch('NEAR foo* "quoted" OR').fts).toBe('"NEAR" AND "foo*" AND """quoted"""');
    expect(planSearch("a% _ \\").likes).toEqual(["%a\\%%", "%\\_%", "%\\\\%"]);
  });

  test("an empty input has no terms", () => {
    expect(planSearch("   ")).toEqual({ fts: null, likes: [], terms: [] });
  });
});

describe("snippets", () => {
  test("makeSnippet cuts around the first occurrence", () => {
    expect(makeSnippet("0123456789検索ABCDEFGHIJ", ["検索"], 3)).toBe("…789⟪検索⟫ABC…");
    expect(makeSnippet("Xy xy", ["xY"], 10)).toBe("⟪Xy⟫ ⟪xy⟫");
  });

  // docs/adr/0018: a window per term, so that every term of an AND search shows.
  test("makeSnippet cuts a window around each term, joined with …", () => {
    expect(makeSnippet(`alpha${"x".repeat(100)}beta`, ["alpha", "beta"], 3)).toBe("⟪alpha⟫xxx…xxx⟪beta⟫");
    expect(makeSnippet(`前${"x".repeat(100)}梨${"y".repeat(100)}柿${"z".repeat(10)}`, ["柿", "梨"], 2)).toBe("…xx⟪梨⟫yy…yy⟪柿⟫zz…");
  });

  test("makeSnippet merges close windows", () => {
    expect(makeSnippet("0123alpha45beta6789", ["alpha", "beta"], 2)).toBe("…23⟪alpha⟫45⟪beta⟫67…");
  });

  test("makeSnippet marks every occurrence in the windows and does not cut a term", () => {
    expect(makeSnippet("Alpha alpha", ["alpha"], 10)).toBe("⟪Alpha⟫ ⟪alpha⟫");
    expect(makeSnippet("alphaZalpha!!!!", ["alpha"], 2)).toBe("⟪alpha⟫Z⟪alpha⟫…");
  });

  test("makeSnippet falls back to the head of the text", () => {
    expect(makeSnippet("あ".repeat(100), ["zzz"], 32)).toBe(`${"あ".repeat(64)}…`);
    expect(makeSnippet("短い", ["zzz"], 32)).toBe("短い");
  });

  test("makeSnippet keeps Markdown bold in the text distinguishable", () => {
    expect(makeSnippet("これは**重複**です", ["重複"], 10)).toBe("これは**⟪重複⟫**です");
    expect(makeSnippet("実行", ["実", "行"], 10)).toBe("⟪実行⟫");
  });
});

describe("blocks", () => {
  test("toBlocks reads strings and block arrays", () => {
    expect(toBlocks("hi")).toEqual([{ kind: "text", text: "hi" }]);
    expect(
      toBlocks([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
        { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        { type: "tool_result", content: [{ type: "text", text: "out" }] },
        { type: "injected_prompt_block", prompt: "x" },
      ]),
    ).toEqual([
      { kind: "thinking", text: "hmm" },
      { kind: "text", text: "answer" },
      { kind: "tool_use", name: "Bash", input: '{"command":"ls -la"}' },
      { kind: "tool_result", text: "out" },
      { kind: "other", type: "injected_prompt_block" },
    ]);
    expect(toBlocks(undefined)).toEqual([]);
  });

  const options = { thinking: false, tools: false, maxChars: 2000 };

  // docs/adr/0019: thinking kept with only a signature has an empty body.
  test("renderBlock never shows a thinking block with an empty body", () => {
    const thinking = { ...options, thinking: true };
    expect(renderBlock({ kind: "thinking", text: "" }, thinking)).toBeNull();
    expect(renderBlock({ kind: "thinking", text: "  \n" }, thinking)).toBeNull();
    expect(renderBlock({ kind: "thinking", text: "考え" }, thinking)).toBe("[thinking] 考え");
  });

  test("renderBlock shows text, hides thinking by default and summarizes tools", () => {
    expect(renderBlock({ kind: "text", text: "本文" }, options)).toBe("本文");
    expect(renderBlock({ kind: "thinking", text: "考え" }, options)).toBeNull();
    expect(renderBlock({ kind: "thinking", text: "考え" }, { ...options, thinking: true })).toBe("[thinking] 考え");
    const long = "x".repeat(300);
    expect(renderBlock({ kind: "tool_use", name: "Bash", input: long }, options)).toBe(`[tool_use Bash] ${"x".repeat(200)}`);
    expect(renderBlock({ kind: "tool_result", text: `a\nb${long}` }, options)).toBe(`[tool_result] a b${"x".repeat(197)}`);
    expect(renderBlock({ kind: "tool_result", text: long }, { ...options, tools: true })).toBe(`[tool_result]\n${long}`);
    expect(renderBlock({ kind: "other", type: "image" }, options)).toBe("[image]");
  });

  // docs/adr/0013
  test("non-text blocks inside a tool result become their type", () => {
    expect(toBlocks([{ type: "tool_result", content: [{ type: "text", text: "撮った" }, { type: "image", source: { data: "x".repeat(500) } }] }])).toEqual([
      { kind: "tool_result", text: "撮った\n[image]" },
    ]);
  });

  test("long base64 runs are replaced, also with a data URL prefix", () => {
    const b64 = "A".repeat(250);
    expect(replaceBase64(`前 ${b64} 後`)).toBe("前 [base64 250 文字] 後");
    expect(replaceBase64(`data:image/png;base64,${b64}`)).toBe("[base64 272 文字]");
    expect(replaceBase64("B".repeat(199))).toBe("B".repeat(199));
    expect(toBlocks([{ type: "tool_result", content: `img ${b64}` }])).toEqual([{ kind: "tool_result", text: "img [base64 250 文字]" }]);
    expect(toBlocks(`本文 ${b64}`)).toEqual([{ kind: "text", text: "本文 [base64 250 文字]" }]);
  });

  test("trailing blank lines of a body are dropped", () => {
    expect(renderBlock({ kind: "thinking", text: "考え\n\n\n" }, { ...options, thinking: true })).toBe("[thinking] 考え");
    expect(renderBlock({ kind: "text", text: "本文\n\n" }, options)).toBe("本文");
  });

  test("truncate adds a note and 0 disables it", () => {
    expect(truncate("あいうえお", 3)).toBe("あいう…（5 文字のうち 3 文字）");
    expect(truncate("あいうえお", 5)).toBe("あいうえお");
    expect(truncate("あいうえお", 0)).toBe("あいうえお");
  });
});

describe("matchSession", () => {
  const ids = ["abcdef12-0000", "abcdef12-1111", "12345678-aaaa"];

  test("a unique prefix of 8 or more characters", () => {
    expect(matchSession("12345678", ids)).toEqual({ kind: "found", id: "12345678-aaaa" });
    expect(matchSession("12345678-aaaa", ids)).toEqual({ kind: "found", id: "12345678-aaaa" });
  });

  test("ambiguous, missing and too short prefixes", () => {
    expect(matchSession("abcdef12", ids)).toEqual({ kind: "ambiguous", ids: ["abcdef12-0000", "abcdef12-1111"] });
    expect(matchSession("ffffffff", ids)).toEqual({ kind: "none" });
    expect(matchSession("1234567", ids)).toEqual({ kind: "short" });
  });
});
