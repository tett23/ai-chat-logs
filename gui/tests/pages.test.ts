import { describe, expect, test } from "bun:test";
import { initialRange, nextRange, PAGE_SIZE, prevRange } from "../src/pages.ts";

// docs/adr/0014
describe("initialRange", () => {
  test("from the list: the first page", () => {
    expect(PAGE_SIZE).toBe(100);
    expect(initialRange(null, 79_083)).toEqual({ from: 1, to: 100 });
  });

  test("from a search hit: starting 50 before the hit", () => {
    expect(initialRange(1_000, 79_083)).toEqual({ from: 950, to: 1_049 });
    expect(initialRange(30, 79_083)).toEqual({ from: 1, to: 100 });
    expect(initialRange(50, 79_083)).toEqual({ from: 1, to: 100 });
    expect(initialRange(51, 79_083)).toEqual({ from: 1, to: 100 });
    expect(initialRange(52, 79_083)).toEqual({ from: 2, to: 101 });
  });

  test("short sessions and empty ones", () => {
    expect(initialRange(null, 7)).toEqual({ from: 1, to: 7 });
    expect(initialRange(5, 7)).toEqual({ from: 1, to: 7 });
    expect(initialRange(null, 0)).toBeNull();
  });
});

describe("nextRange", () => {
  test("the page after the loaded range", () => {
    expect(nextRange({ from: 1, to: 100 }, 250)).toEqual({ from: 101, to: 200 });
    expect(nextRange({ from: 101, to: 200 }, 250)).toEqual({ from: 201, to: 250 });
  });

  test("nothing after the last message", () => {
    expect(nextRange({ from: 201, to: 250 }, 250)).toBeNull();
  });
});

describe("prevRange", () => {
  test("the page before the loaded range, cut at 1", () => {
    expect(prevRange({ from: 950, to: 1_049 })).toEqual({ from: 850, to: 949 });
    expect(prevRange({ from: 30, to: 129 })).toEqual({ from: 1, to: 29 });
  });

  test("nothing before the first message", () => {
    expect(prevRange({ from: 1, to: 100 })).toBeNull();
  });
});
