import { describe, expect, test } from "bun:test";
import { HIT_END, HIT_START, splitSnippet } from "../src/snippet.ts";

const hit = (s: string) => `${HIT_START}${s}${HIT_END}`;

describe("splitSnippet", () => {
  test("splits highlighted and plain parts", () => {
    expect(splitSnippet(`前${hit("検索語")}後`)).toEqual([
      { text: "前", hit: false },
      { text: "検索語", hit: true },
      { text: "後", hit: false },
    ]);
  });

  test("handles several hits and adjacent hits", () => {
    expect(splitSnippet(`${hit("a")}${hit("b")} c ${hit("d")}`)).toEqual([
      { text: "a", hit: true },
      { text: "b", hit: true },
      { text: " c ", hit: false },
      { text: "d", hit: true },
    ]);
  });

  test("keeps HTML special characters as text", () => {
    expect(splitSnippet(`<b>&amp;${hit("<script>")}`)).toEqual([
      { text: "<b>&amp;", hit: false },
      { text: "<script>", hit: true },
    ]);
  });

  test("treats an unterminated hit as highlighted to the end", () => {
    expect(splitSnippet(`x${HIT_START}y`)).toEqual([
      { text: "x", hit: false },
      { text: "y", hit: true },
    ]);
  });

  test("returns nothing for an empty string", () => {
    expect(splitSnippet("")).toEqual([]);
  });
});
