import { describe, expect, test } from "bun:test";
import { exportFileName } from "../src/export.ts";

// docs/adr/0026
describe("exportFileName", () => {
  test("the title with / and : made -, and .md", () => {
    expect(exportFileName("設計の議論", "aaaaaaaa-1111")).toBe("設計の議論.md");
    expect(exportFileName("a/b: c", "aaaaaaaa-1111")).toBe("a-b- c.md");
  });

  test("the session ID without a title", () => {
    expect(exportFileName(null, "aaaaaaaa-1111")).toBe("aaaaaaaa-1111.md");
    expect(exportFileName("", "aaaaaaaa-1111")).toBe("aaaaaaaa-1111.md");
  });
});
