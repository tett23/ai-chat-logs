import { describe, expect, test } from "bun:test";
import { extractFields } from "../src/extract.ts";

const empty = { type: null, uuid: null, sessionId: null, timestamp: null };

describe("extractFields: claude-code/transcript", () => {
  test("takes type, uuid, sessionId and timestamp", () => {
    const raw = JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-10-14T00:00:01.000Z" });
    expect(extractFields("claude-code/transcript", raw)).toEqual({
      type: "user",
      uuid: "u1",
      sessionId: "s1",
      timestamp: "2026-10-14T00:00:01.000Z",
    });
  });

  test("uses null for values that are not strings", () => {
    const raw = JSON.stringify({ type: 1, uuid: null, sessionId: {}, timestamp: 1780525414056 });
    expect(extractFields("claude-code/transcript", raw)).toEqual(empty);
  });

  test.each(["not json", "[1,2]", "42", '"str"', "null"])("uses null for %p", (raw) => {
    expect(extractFields("claude-code/transcript", raw)).toEqual(empty);
  });
});

describe("extractFields: claude-code/history", () => {
  test("converts the millisecond timestamp to ISO 8601", () => {
    const raw = JSON.stringify({ display: "/plan", timestamp: 1780525414056, sessionId: "s1", type: "x", uuid: "u" });
    expect(extractFields("claude-code/history", raw)).toEqual({
      type: null,
      uuid: null,
      sessionId: "s1",
      timestamp: new Date(1780525414056).toISOString(),
    });
  });

  test("uses null for a timestamp that is not a number", () => {
    expect(extractFields("claude-code/history", JSON.stringify({ timestamp: "2026" })).timestamp).toBeNull();
  });
});

describe("extractFields: other providers", () => {
  const transcriptLine = JSON.stringify({ type: "assistant", uuid: "u", sessionId: "s", timestamp: "2026-10-15T00:00:00.000Z" });

  test("Cowork transcripts and claude.ai conversations are read like Claude Code transcripts", () => {
    const expected = extractFields("claude-code/transcript", transcriptLine);
    expect(extractFields("claude-cowork/transcript", transcriptLine)).toEqual(expected);
    expect(extractFields("claude-ai/conversation", transcriptLine)).toEqual(expected);
  });

  test("Cowork audit lines use session_id and _audit_timestamp", () => {
    const raw = JSON.stringify({ type: "user", uuid: "u1", session_id: "local-id", sessionId: "ignored", _audit_timestamp: "2026-07-01T17:10:07.552Z" });
    expect(extractFields("claude-cowork/audit", raw)).toEqual({
      type: "user",
      uuid: "u1",
      sessionId: "local-id",
      timestamp: "2026-07-01T17:10:07.552Z",
    });
  });
});

