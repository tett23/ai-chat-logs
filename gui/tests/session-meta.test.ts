import { describe, expect, test } from "bun:test";
import { lastPathPart, sessionTooltip, sidebarMeta } from "../src/session-meta.ts";

// docs/adr/0040
const time = (iso: string | null): string => iso ?? "";
const session = {
  session_id: "0123456789abcdef",
  title: "題",
  cwd: "/work/proj/" as string | null,
  first_at: "2026-11-01" as string | null,
  last_at: "2026-11-02" as string | null,
  message_count: 12,
};

describe("the second line of a session in the sidebar", () => {
  test("ADR 0040 I10: time, count, the last part of cwd and the short ID, in order", () => {
    expect(sidebarMeta(session, time)).toBe("2026-11-02 · 12 件 · proj · 01234567");
  });

  test("ADR 0040 I10: without cwd, its part is left out", () => {
    expect(sidebarMeta({ ...session, cwd: null }, time)).toBe("2026-11-02 · 12 件 · 01234567");
    expect(sidebarMeta({ ...session, cwd: "" }, time)).toBe("2026-11-02 · 12 件 · 01234567");
  });

  test("the last part of a path", () => {
    expect(lastPathPart("/a/b")).toBe("b");
    expect(lastPathPart("/a/b//")).toBe("b");
    expect(lastPathPart("/")).toBe("/");
    expect(lastPathPart("rel")).toBe("rel");
  });

  test("the tooltip carries the whole title, ID, cwd and period", () => {
    expect(sessionTooltip(session, time)).toBe("題\nセッションID: 0123456789abcdef\ncwd: /work/proj/\n期間: 2026-11-01 〜 2026-11-02");
    expect(sessionTooltip({ ...session, title: null, cwd: null }, time)).toBe("0123456789abcdef\nセッションID: 0123456789abcdef\n期間: 2026-11-01 〜 2026-11-02");
  });
});
