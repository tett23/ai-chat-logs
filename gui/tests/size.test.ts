import { describe, expect, test } from "bun:test";
import { formatSize } from "../src/size.ts";

// docs/adr/0025
describe("formatSize", () => {
  test("units of 1000, two decimals, bytes as integers", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(999)).toBe("999 B");
    expect(formatSize(1000)).toBe("1.00 KB");
    expect(formatSize(812_300_000)).toBe("812.30 MB");
    expect(formatSize(4_450_611_200)).toBe("4.45 GB");
    expect(formatSize(1000 ** 4)).toBe("1.00 TB");
    expect(formatSize(1000 ** 5)).toBe("1000.00 TB");
  });
});
