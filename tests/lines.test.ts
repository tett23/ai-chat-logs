import { describe, expect, test } from "bun:test";
import { splitCompleteLines } from "../src/lines.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("splitCompleteLines", () => {
  test("returns lines up to the last newline and the consumed byte count", () => {
    expect(splitCompleteLines(enc("a\nbb\n"))).toEqual({ lines: ["a", "bb"], consumed: 5 });
  });

  test("leaves a trailing partial line unconsumed", () => {
    expect(splitCompleteLines(enc("a\nbb"))).toEqual({ lines: ["a"], consumed: 2 });
  });

  test("returns nothing for input without a newline", () => {
    expect(splitCompleteLines(enc("abc"))).toEqual({ lines: [], consumed: 0 });
  });

  test("returns nothing for empty input", () => {
    expect(splitCompleteLines(new Uint8Array())).toEqual({ lines: [], consumed: 0 });
  });

  test("keeps empty lines so that line numbers can be counted", () => {
    expect(splitCompleteLines(enc("\n\n"))).toEqual({ lines: ["", ""], consumed: 2 });
  });

  test("strips a trailing carriage return", () => {
    expect(splitCompleteLines(enc("a\r\nb\r\n"))).toEqual({ lines: ["a", "b"], consumed: 6 });
  });

  test("decodes only complete lines when a multibyte character is split", () => {
    const bytes = enc("日本語🎉\n続き😀");
    // cut in the middle of 😀 (4 bytes)
    const cut = bytes.slice(0, bytes.length - 2);
    const { lines, consumed } = splitCompleteLines(cut);
    expect(lines).toEqual(["日本語🎉"]);
    expect(consumed).toBe(enc("日本語🎉\n").length);
  });
});
