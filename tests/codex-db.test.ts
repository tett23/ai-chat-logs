import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { messageCount, search, sessionIds, sessionMessages, sessionSummary } from "../src/chat-log/store.ts";
import { planSearch } from "../src/chat-log/search.ts";
import { importSources } from "../src/import.ts";
import { restoredRaw } from "../src/payloads.ts";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

const record = (sessionId: string, uuid: string, text: string, sourceOrder = 0) => ({
  type: "user", uuid, sessionId, timestamp: "2026-11-01T00:00:00Z", sourceOrder,
  message: { role: "user", content: text },
});

const source = (kind: string, path: string) => ({ kind, path });
const rows = (db: Database, sql: string) => db.query(sql).all();
const openV6 = (path: string): Database => {
  const db = new Database(path);
  for (let version = 1; version <= 6; version += 1) {
    const name = ["initial", "search-and-summaries", "other-providers", "session-message-indexes", "tool-texts", "payloads"][version - 1];
    db.run(readFileSync(join(import.meta.dir, `../schema/${String(version).padStart(4, "0")}-${name}.sql`), "utf8"));
    db.run(`PRAGMA user_version = ${version}`);
  }
  return db;
};

describe("ADR 0033", () => {
  test("D1 migration preserves existing records, FTS, summaries and rowids", () => {
    const dir = tempDir();
    const path = join(dir, "logs.sqlite");
    const db = openV6(path);
    const file = writeFile(join(dir, "claude.jsonl"), jsonl(record("same0001", "claude-1", "旧本文")));
    const bigTool = { type: "user", uuid: "tool1", sessionId: "same0001", timestamp: "2026-11-01T00:00:01Z", message: { role: "user", content: [{ type: "tool_result", content: "T".repeat(1025) }] } };
    const toolFile = writeFile(join(dir, "tool.jsonl"), jsonl(bigTool));
    importSources(db, [source("claude-code/transcript", file), source("claude-code/transcript", toolFile)], {});
    const tables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => (r as { name: string }).name);
    const before = tables.map((table) => rows(db, `SELECT * FROM "${table}"`));
    const recordRowids = rows(db, "SELECT rowid FROM records ORDER BY rowid");
    const rawBefore = db.query<{ raw: string; payload_state: number | null }, []>("SELECT raw, payload_state FROM records ORDER BY rowid").all().map((r) => restoredRaw(db)(r.raw, r.payload_state));
    expect(rows(db, "SELECT count(*) n FROM payloads")).toEqual([{ n: 1 }]);
    db.close();
    const afterDb = openDatabase(path);
    expect(rows(afterDb, "PRAGMA user_version")).toEqual([{ user_version: 7 }]);
    expect(tables.map((table) => rows(afterDb, `SELECT * FROM "${table}"`))).toEqual(before);
    expect(rows(afterDb, "SELECT rowid FROM records ORDER BY rowid")).toEqual(recordRowids);
    expect(afterDb.query<{ raw: string; payload_state: number | null }, []>("SELECT raw, payload_state FROM records ORDER BY rowid").all().map((r) => restoredRaw(afterDb)(r.raw, r.payload_state))).toEqual(rawBefore);
  });

  test("D2 raw rollout stays outside conversation and both search views", () => {
    const dir = tempDir(); const db = openDatabase(join(dir, "logs.sqlite"));
    importSources(db, [source("codex/rollout", writeFile(join(dir, "raw.jsonl"), jsonl(record("same0001", "same-uuid", "原本の語句"))))], {});
    expect(rows(db, "SELECT * FROM session_messages")).toHaveLength(0);
    expect(rows(db, "SELECT * FROM record_text_source")).toHaveLength(0);
    expect(rows(db, "SELECT * FROM record_tool_text_source")).toHaveLength(0);
  });

  test("D3 same session ID stays separated by provider and Codex uses sourceOrder", () => {
    const dir = tempDir(); const db = openDatabase(join(dir, "logs.sqlite"));
    const entries = [
      source("claude-code/transcript", writeFile(join(dir, "c.jsonl"), jsonl(record("same0001", "c", "Claude本文")))),
      source("codex/conversation", writeFile(join(dir, "a.jsonl"), jsonl(record("same0001", "z", "Codex後", 2)))),
      source("codex/conversation", writeFile(join(dir, "z.jsonl"), jsonl(record("same0001", "a", "Codex先", 1)))),
    ];
    importSources(db, entries, {});
    expect(sessionIds(db, "same0001")).toEqual([{ provider: "claude-code", session_id: "same0001" }, { provider: "codex", session_id: "same0001" }]);
    expect(messageCount(db, "codex", "same0001")).toBe(2);
    expect(sessionSummary(db, "claude-code", "same0001")?.message_count).toBe(1);
    expect(sessionMessages(db, "codex", "same0001", 1, 2).map((m) => m.uuid)).toEqual(["a", "z"]);
    const cli = (args: string[]) => {
      const r = Bun.spawnSync(["bun", join(repoRoot, "src/cli/chat-log.ts"), ...args], { env: isolatedEnv({ AI_CHAT_LOGS_DB: join(dir, "logs.sqlite") }) });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    const ambiguous = cli(["show", "same0001"]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain("claude-code\tsame0001");
    expect(ambiguous.err).toContain("codex\tsame0001");
    const codex = cli(["show", "same0001", "--provider", "codex"]);
    expect(codex.out).toContain("Codex先");
    expect(codex.out).not.toContain("Claude本文");
    const exported = cli(["export", "same0001", "--provider", "codex"]);
    expect(exported.code).toBe(0);
    expect(exported.out).toContain("Codex先");
    expect(exported.out).not.toContain("Claude本文");
    expect(cli(["show", "unknown00"]).code).toBe(1);
  });

  test("D3 four providers, a 51st page item and missing-time ordering keep indexes local", () => {
    const dir = tempDir(); const db = openDatabase(join(dir, "logs.sqlite"));
    const id = "collision001";
    const claudeKinds = ["claude-code/transcript", "claude-ai/conversation", "claude-cowork/transcript"];
    const entries = claudeKinds.map((kind, i) => source(kind, writeFile(join(dir, `claude-${i}.jsonl`), jsonl(record(id, `c${i}`, `共有語 Claude ${i}`)))));
    const codex = Array.from({ length: 51 }, (_, i) => ({
      ...record(id, `x${i}`, `共有語 Codex ${i}`, i),
      timestamp: i >= 49 ? undefined : "2026-11-01T00:00:00Z",
    }));
    entries.push(source("codex/conversation", writeFile(join(dir, "codex.jsonl"), codex.map((v) => JSON.stringify(v)).join("\n") + "\n")));
    importSources(db, entries, {});
    expect(sessionIds(db, id)).toHaveLength(4);
    for (const provider of ["claude-code", "claude-ai", "claude-cowork"]) {
      expect(messageCount(db, provider, id)).toBe(1);
      expect(sessionMessages(db, provider, id, 1, 50)).toHaveLength(1);
    }
    expect(messageCount(db, "codex", id)).toBe(51);
    expect(sessionMessages(db, "codex", id, 1, 50)).toHaveLength(50);
    expect(sessionMessages(db, "codex", id, 51, 51).map((m) => m.uuid)).toEqual(["x48"]);
    expect(sessionMessages(db, "codex", id, 1, 3).map((m) => m.uuid)).toEqual(["x49", "x50", "x0"]);
    const hit = search(db, planSearch("Codex 50"), { provider: "codex" }, 10, 0);
    expect(hit.map((h) => h.index)).toEqual([2]);
  });

  test("D4 failed migration rolls back views and version, then retries", () => {
    const dir = tempDir(); const path = join(dir, "logs.sqlite");
    const db = openV6(path);
    const before = rows(db, "SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name");
    const sql = readFileSync(join(import.meta.dir, "../schema/0007-codex-conversations.sql"), "utf8");
    expect(() => db.transaction(() => { db.run(sql); throw new Error("fail"); })()).toThrow("fail");
    expect(rows(db, "PRAGMA user_version")).toEqual([{ user_version: 6 }]);
    expect(rows(db, "SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name")).toEqual(before);
    db.close(); const retried = openDatabase(path);
    expect(rows(retried, "PRAGMA user_version")).toEqual([{ user_version: 7 }]);
  });

  test("D5 indexed text uses converted conversation, not raw marker", () => {
    const dir = tempDir(); const db = openDatabase(join(dir, "logs.sqlite"));
    importSources(db, [source("codex/conversation", writeFile(join(dir, "conv.jsonl"), jsonl(record("same0001", "m", "変換本文"))))], {});
    expect(rows(db, "SELECT text FROM record_texts")).toEqual([{ text: "変換本文" }]);
  });

  test("D5 tool text at 1023, 1024 and 1025 bytes indexes before extraction and restores", () => {
    const dir = tempDir(); const db = openDatabase(join(dir, "logs.sqlite"));
    const values = [1023, 1024, 1025].map((size, i) => ({
      type: "user", uuid: `tool-${i}`, sessionId: "tools000", timestamp: `2026-11-01T00:00:0${i}Z`, sourceOrder: i,
      message: { role: "user", content: [{ type: "tool_result", content: `境界${i}` + "x".repeat(size - 7) }] },
    }));
    const lines = values.map((v) => JSON.stringify(v));
    importSources(db, [source("codex/conversation", writeFile(join(dir, "tools.jsonl"), lines.join("\n") + "\n"))], {});
    const indexed = rows(db, "SELECT text FROM record_tool_texts ORDER BY rowid") as { text: string }[];
    expect(indexed).toHaveLength(3);
    expect(indexed.every((row, i) => row.text === values[i]?.message.content[0]?.content)).toBe(true);
    expect(indexed.every((row) => !row.text.includes("ai-chat-logs-payload"))).toBe(true);
    const stored = db.query<{ raw: string; payload_state: number | null }, []>("SELECT raw, payload_state FROM records ORDER BY rowid").all();
    expect(stored.map((r) => restoredRaw(db)(r.raw, r.payload_state))).toEqual(lines);
    expect(stored.every((r) => r.payload_state === 1)).toBe(true);
  });

  test("D6 copies deduplicate within kind, not against raw rollout", () => {
    const dir = tempDir(); const db = openDatabase(join(dir, "logs.sqlite"));
    const x = record("same0001", "shared", "一度だけ表示");
    importSources(db, [
      source("codex/rollout", writeFile(join(dir, "0-raw.jsonl"), jsonl(x))),
      source("codex/conversation", writeFile(join(dir, "1-conv.jsonl"), jsonl(x))),
      source("codex/conversation", writeFile(join(dir, "2-copy.jsonl"), jsonl(x))),
    ], {});
    expect(rows(db, "SELECT * FROM session_messages")).toHaveLength(1);
    expect(rows(db, "SELECT * FROM copied_records")).toHaveLength(1);
    expect(search(db, planSearch("一度だけ表示"), { provider: "codex" }, 10, 0)).toHaveLength(1);
    const changed = { ...x, uuid: "version-2", message: { role: "user", content: "二版目" }, openai: { itemId: "shared", version: "222222222222" } };
    importSources(db, [source("codex/conversation", writeFile(join(dir, "3-version.jsonl"), jsonl(changed)))], {});
    expect(messageCount(db, "codex", "same0001")).toBe(2);
    expect(sessionMessages(db, "codex", "same0001", 1, 2).map((m) => m.version)).toContain("222222222222");
  });
});
