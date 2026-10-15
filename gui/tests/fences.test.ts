import { describe, expect, test } from "bun:test";
import { splitFences } from "../src/fences.ts";

describe("splitFences", () => {
  test("returns plain text as one part", () => {
    expect(splitFences("hello\nworld")).toEqual([{ kind: "text", text: "hello\nworld" }]);
  });

  test("splits fenced code with a language", () => {
    expect(splitFences("before\n```ts\nconst a = 1;\n```\nafter")).toEqual([
      { kind: "text", text: "before" },
      { kind: "code", lang: "ts", text: "const a = 1;" },
      { kind: "text", text: "after" },
    ]);
  });

  test("fenced code without a language", () => {
    expect(splitFences("```\nx\n```")).toEqual([{ kind: "code", lang: "", text: "x" }]);
  });

  test("an unterminated fence runs to the end", () => {
    expect(splitFences("a\n```sh\nls\npwd")).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "sh", text: "ls\npwd" },
    ]);
  });

  test("a fence with a language inside code does not nest", () => {
    expect(splitFences("```md\n```ts\ninner\n```\nrest")).toEqual([
      { kind: "code", lang: "md", text: "```ts\ninner" },
      { kind: "text", text: "rest" },
    ]);
  });

  test("keeps empty code blocks and drops empty text parts", () => {
    expect(splitFences("```\n```")).toEqual([{ kind: "code", lang: "", text: "" }]);
  });
});
