import { describe, expect, test } from "bun:test";
import { ALL_SHOWN, blockShown, messageShown, parseShown, serializeShown } from "../src/visibility.ts";

// docs/adr/0024
describe("blockShown", () => {
  test("text and other blocks always show", () => {
    const none = { thinking: false, tool_use: false, tool_result: false };
    expect(blockShown("text", none)).toBe(true);
    expect(blockShown("other", none)).toBe(true);
  });

  test("thinking, tool_use and tool_result follow the menu", () => {
    const shown = { thinking: false, tool_use: true, tool_result: false };
    expect(blockShown("thinking", shown)).toBe(false);
    expect(blockShown("tool_use", shown)).toBe(true);
    expect(blockShown("tool_result", shown)).toBe(false);
    expect(blockShown("thinking", ALL_SHOWN)).toBe(true);
  });
});

describe("messageShown", () => {
  const noTools = { thinking: true, tool_use: false, tool_result: false };

  test("a message shows when any of its blocks shows", () => {
    expect(messageShown(["tool_use", "text"], noTools, false)).toBe(true);
    expect(messageShown(["tool_result"], noTools, false)).toBe(false);
    expect(messageShown(["tool_use", "tool_result"], noTools, false)).toBe(false);
  });

  test("a highlighted message and a message without blocks always show", () => {
    expect(messageShown(["tool_result"], noTools, true)).toBe(true);
    expect(messageShown([], noTools, false)).toBe(true);
  });
});

describe("parseShown and serializeShown", () => {
  test("a saved state comes back", () => {
    const shown = { thinking: false, tool_use: true, tool_result: false };
    expect(parseShown(serializeShown(shown))).toEqual(shown);
  });

  test("a missing or malformed value means everything shows", () => {
    expect(parseShown(null)).toEqual(ALL_SHOWN);
    expect(parseShown("not json")).toEqual(ALL_SHOWN);
    expect(parseShown("[false]")).toEqual(ALL_SHOWN);
    expect(parseShown('{"thinking": "no"}')).toEqual(ALL_SHOWN);
  });

  test("unknown kinds are ignored and missing kinds show", () => {
    expect(parseShown('{"thinking": false, "images": false}')).toEqual({ thinking: false, tool_use: true, tool_result: true });
  });
});
