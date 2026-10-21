import { describe, expect, test } from "bun:test";
import { initialRange, newerRange, newestFirst, olderRange, PAGE_SIZE } from "../src/pages.ts";

// docs/adr/0014, docs/adr/0016
describe("initialRange", () => {
  test("from the list: the last page (newest first)", () => {
    expect(PAGE_SIZE).toBe(100);
    expect(initialRange(null, 79_083)).toEqual({ from: 78_984, to: 79_083 });
  });

  test("from a search hit: starting 50 before the hit", () => {
    expect(initialRange(1_000, 79_083)).toEqual({ from: 950, to: 1_049 });
    expect(initialRange(30, 79_083)).toEqual({ from: 1, to: 100 });
    expect(initialRange(52, 79_083)).toEqual({ from: 2, to: 101 });
  });

  test("short sessions and empty ones", () => {
    expect(initialRange(null, 7)).toEqual({ from: 1, to: 7 });
    expect(initialRange(5, 7)).toEqual({ from: 1, to: 7 });
    expect(initialRange(null, 0)).toBeNull();
  });
});

describe("olderRange", () => {
  test("the page before the loaded range, cut at 1", () => {
    expect(olderRange({ from: 78_984, to: 79_083 })).toEqual({ from: 78_884, to: 78_983 });
    expect(olderRange({ from: 30, to: 129 })).toEqual({ from: 1, to: 29 });
  });

  test("nothing before the first message", () => {
    expect(olderRange({ from: 1, to: 100 })).toBeNull();
  });
});

describe("newerRange", () => {
  test("the page after the loaded range, cut at the total", () => {
    expect(newerRange({ from: 950, to: 1_049 }, 79_083)).toEqual({ from: 1_050, to: 1_149 });
    expect(newerRange({ from: 101, to: 200 }, 250)).toEqual({ from: 201, to: 250 });
  });

  test("nothing after the last message", () => {
    expect(newerRange({ from: 201, to: 250 }, 250)).toBeNull();
  });
});

describe("newestFirst", () => {
  test("orders messages by number, largest first", () => {
    expect(newestFirst([{ index: 3 }, { index: 1 }, { index: 2 }]).map((m) => m.index)).toEqual([3, 2, 1]);
  });
});
