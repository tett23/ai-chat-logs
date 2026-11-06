import { describe, expect, test } from "bun:test";
import { highlightParts, searchTerms } from "../src/highlight.ts";

// docs/adr/0026
describe("highlightParts", () => {
  test("splits the text at the terms", () => {
    expect(highlightParts("前に検索語があり、検索語で終わる検索語", ["検索語"])).toEqual([
      { text: "前に", hit: false },
      { text: "検索語", hit: true },
      { text: "があり、", hit: false },
      { text: "検索語", hit: true },
      { text: "で終わる", hit: false },
      { text: "検索語", hit: true },
    ]);
  });

  test("ignores ASCII case", () => {
    expect(highlightParts("SQLite と sqlite", ["Sqlite"])).toEqual([
      { text: "SQLite", hit: true },
      { text: " と ", hit: false },
      { text: "sqlite", hit: true },
    ]);
  });

  test("overlapping and adjacent matches become one part", () => {
    expect(highlightParts("abcdef", ["abc", "bcd", "ef"])).toEqual([{ text: "abcdef", hit: true }]);
    expect(highlightParts("xx実行yy", ["実", "行"])).toEqual([
      { text: "xx", hit: false },
      { text: "実行", hit: true },
      { text: "yy", hit: false },
    ]);
  });

  test("no terms leave the text whole", () => {
    expect(highlightParts("本文", [])).toEqual([{ text: "本文", hit: false }]);
    expect(highlightParts("", ["x"])).toEqual([]);
  });
});

describe("searchTerms", () => {
  test("the query split at spaces", () => {
    expect(searchTerms("  写し  重複 ")).toEqual(["写し", "重複"]);
    expect(searchTerms("")).toEqual([]);
  });
});
