import { describe, expect, test } from "bun:test";
import { detectChange } from "../src/change.ts";

describe("detectChange", () => {
  test("rewritten when the file shrank", () => {
    expect(detectChange({ size: 5, consumedBytes: 10, storedHead: "h", currentHead: "h" })).toBe("rewritten");
  });

  test("rewritten when the head hash differs", () => {
    expect(detectChange({ size: 20, consumedBytes: 10, storedHead: "h", currentHead: "x" })).toBe("rewritten");
  });

  test("unchanged when the size equals the consumed bytes", () => {
    expect(detectChange({ size: 10, consumedBytes: 10, storedHead: "h", currentHead: "h" })).toBe("unchanged");
  });

  test("appended when the file grew and the head is the same", () => {
    expect(detectChange({ size: 20, consumedBytes: 10, storedHead: "h", currentHead: "h" })).toBe("appended");
  });

  test("appended for a new source", () => {
    expect(detectChange({ size: 20, consumedBytes: 0, storedHead: null, currentHead: null })).toBe("appended");
  });

  test("unchanged for an empty new source", () => {
    expect(detectChange({ size: 0, consumedBytes: 0, storedHead: null, currentHead: null })).toBe("unchanged");
  });
});
