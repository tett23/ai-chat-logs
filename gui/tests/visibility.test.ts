import { describe, expect, test } from "bun:test";
import { ALL_SHOWN, blockShown, messageShown, parseShown, serializeShown, type Shown, shownMenuLabel } from "../src/visibility.ts";

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
    expect(parseShown(serializeShown(shown))).toEqual({ ...shown, unavailable: false });
  });

  test("a missing or malformed value means everything shows", () => {
    expect(parseShown(null)).toEqual(ALL_SHOWN);
    expect(parseShown("not json")).toEqual(ALL_SHOWN);
    expect(parseShown("[false]")).toEqual(ALL_SHOWN);
    expect(parseShown('{"thinking": "no"}')).toEqual(ALL_SHOWN);
  });

  test("unknown kinds are ignored and missing kinds show", () => {
    expect(parseShown('{"thinking": false, "images": false}')).toEqual({ thinking: false, tool_use: true, tool_result: true, unavailable: false });
  });
});

describe("ADR 0037 V4 encrypted placeholder visibility", () => {
  test("identified placeholder defaults hidden while ordinary text with the same words remains", () => {
    expect(ALL_SHOWN.unavailable).toBe(false);
    expect(blockShown("text", ALL_SHOWN, false)).toBe(true);
    expect(blockShown("text", ALL_SHOWN, true)).toBe(false);
    expect(messageShown(["text"], ALL_SHOWN, false, [0])).toBe(false);
    expect(messageShown(["text", "text"], ALL_SHOWN, false, [1])).toBe(true);
  });

  test("toggle survives serialization and restores default on old settings", () => {
    expect(parseShown(serializeShown({ ...ALL_SHOWN, unavailable: true })).unavailable).toBe(true);
    expect(parseShown('{"thinking":false}').unavailable).toBe(false);
  });
});

describe("the 表示 pulldown label (docs/adr/0046)", () => {
  test.each([
    [ALL_SHOWN, "表示"],
    [{ thinking: true, tool_use: true, tool_result: true }, "表示"],
    [{ ...ALL_SHOWN, tool_use: false }, "表示（1 個を変更）"],
    [{ ...ALL_SHOWN, unavailable: true }, "表示（1 個を変更）"],
    [{ thinking: false, tool_use: false, tool_result: false, unavailable: true }, "表示（4 個を変更）"],
    [parseShown(null), "表示"],
    [parseShown("{"), "表示"],
    [parseShown('{"tool_use":false}'), "表示（1 個を変更）"],
  ] as [Shown, string][])("ADR 0046 I1: %p is labelled %s", (shown, label) => {
    expect(shownMenuLabel(shown)).toBe(label);
  });

  test.each([
    { ...ALL_SHOWN, tool_use: false },
    { ...ALL_SHOWN, unavailable: true },
    { thinking: false, tool_use: false, tool_result: false, unavailable: true },
  ] as Shown[])("ADR 0046 I2: the label of %p survives saving and loading", (shown) => {
    expect(shownMenuLabel(parseShown(serializeShown(shown)))).toBe(shownMenuLabel(shown));
  });
});
