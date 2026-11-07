import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import initial from "../schema/0001-initial.sql" with { type: "text" };
import searchAndSummaries from "../schema/0002-search-and-summaries.sql" with { type: "text" };
import otherProviders from "../schema/0003-other-providers.sql" with { type: "text" };
import sessionMessageIndexes from "../schema/0004-session-message-indexes.sql" with { type: "text" };
import toolTexts from "../schema/0005-tool-texts.sql" with { type: "text" };
import { openDatabase, SCHEMA_VERSION } from "../src/db.ts";
import { importSources, type SourceEntry } from "../src/import.ts";
import { convertPendingPayloads, restoredRaw } from "../src/payloads.ts";
import { isolatedEnv, repoRoot, tempDir, writeFile } from "./helpers.ts";

// docs/adr/0031

const transcript = (path: string): SourceEntry => ({ kind: "claude-code/transcript", path });
const BIG = `大きな結果 ${"r".repeat(3000)}`;
const PNG = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 13) % 256)).toString("base64");
const lines = [
  { type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-11-01T00:00:01Z", cwd: "/w", message: { role: "user", content: "短い質問" } },
  { type: "assistant", uuid: "u2", sessionId: "s1", timestamp: "2026-11-01T00:00:02Z", cwd: "/w", message: { role: "assistant", model: "m", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }] } },
  { type: "user", uuid: "u3", sessionId: "s1", timestamp: "2026-11-01T00:00:03Z", cwd: "/w", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: BIG }] } },
  { type: "user", uuid: "u4", sessionId: "s1", timestamp: "2026-11-01T00:00:04Z", cwd: "/w", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] } },
].map((l) => JSON.stringify(l));

const rows = (db: Database) =>
  db.query<{ rowid: number; raw: string; payload_state: number | null }, []>("SELECT rowid, raw, payload_state FROM records ORDER BY rowid").all();

describe("import with payloads", () => {
  test("new records are stored with markers, restore to the lines, and index the same texts", () => {
    const dir = tempDir();
    const db = openDatabase(join(dir, "t.sqlite"));
    importSources(db, [transcript(writeFile(join(dir, "s.jsonl"), `${lines.join("\n")}\n`))], {});
    const stored = rows(db);
    expect(stored.map((r) => r.payload_state)).toEqual([0, 0, 1, 1]);
    expect(stored[2]?.raw).not.toContain("rrrr");
    expect(stored[3]?.raw).not.toContain(PNG.slice(0, 100));
    const restore = restoredRaw(db);
    expect(stored.map((r) => restore(r.raw, r.payload_state))).toEqual(lines);
    expect(db.query<{ encoding: string }, []>("SELECT encoding FROM payloads ORDER BY encoding").all().map((r) => r.encoding)).toEqual(["base64", "zstd"]);
    const tool = db.query<{ text: string }, []>("SELECT text FROM record_tool_texts ORDER BY rowid").all().map((r) => r.text);
    expect(tool).toEqual([`Read ${JSON.stringify({ file_path: "/x" })}`, BIG]);
    const summary = db.query<{ title: string; cwd: string; message_count: number }, []>("SELECT title, cwd, message_count FROM session_summaries").get();
    expect(summary).toEqual({ title: "短い質問", cwd: "/w", message_count: 4 });
  });

  test("a schema 5 database is migrated and its records converted, restoring to the same lines", () => {
    const dir = tempDir();
    const dbPath = join(dir, "v5.sqlite");
    const old = new Database(dbPath);
    [initial, searchAndSummaries, otherProviders, sessionMessageIndexes, toolTexts].forEach((sql) => old.run(sql));
    old.run("PRAGMA user_version = 5");
    old.query("INSERT INTO sources (id, kind, path, first_seen_at, last_seen_at) VALUES (1, 'claude-code/transcript', '/x.jsonl', 'n', 'n')").run();
    const insert = old.query("INSERT INTO records (source_id, line_no, raw, imported_at, type, uuid, session_id, timestamp) VALUES (1, ?, ?, 'n', 'user', ?, 's1', 't')");
    lines.forEach((l, i) => insert.run(i + 1, l, `u${i + 1}`));
    old.close();

    const db = openDatabase(dbPath);
    expect(db.query<{ v: number }, []>("SELECT user_version v FROM pragma_user_version").get()?.v).toBe(SCHEMA_VERSION);
    expect(rows(db).map((r) => r.payload_state)).toEqual([null, null, null, null]);
    expect(convertPendingPayloads(db, 3)).toBe(4);
    const restore = restoredRaw(db);
    const after = rows(db);
    expect(after.map((r) => r.payload_state)).toEqual([0, 0, 1, 1]);
    expect(after.map((r) => restore(r.raw, r.payload_state))).toEqual(lines);
    expect(convertPendingPayloads(db, 3)).toBe(0);
  });

  test("chat-log-import converts pending records after importing", () => {
    const dir = tempDir();
    const dbPath = join(dir, "t.sqlite");
    const db = openDatabase(dbPath);
    importSources(db, [transcript(writeFile(join(dir, "s.jsonl"), `${lines.join("\n")}\n`))], {});
    // as if imported before schema 6: the lines as they were, not processed
    rows(db).forEach((r, i) => db.run("UPDATE records SET raw = ?, payload_state = NULL WHERE rowid = ?", [lines[i] as string, r.rowid]));
    db.run("DELETE FROM payloads");
    db.close();
    const result = Bun.spawnSync(["bun", join(repoRoot, "src/cli/import.ts"), "--db", dbPath], { stdin: new Blob([""]), env: isolatedEnv() });
    expect(result.exitCode).toBe(0);
    const again = new Database(dbPath, { readonly: true });
    expect(rows(again)[2]?.payload_state).toBe(1);
    expect(rows(again)[2]?.raw).not.toContain("rrrr");
    expect(restoredRaw(again)(rows(again)[2]?.raw as string, 1)).toBe(lines[2] as string);
  });
});
