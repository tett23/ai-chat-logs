import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION } from "../src/db.ts";
import { type SourceEntry, importSources } from "../src/import.ts";
import { jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

const setup = () => {
  const dir = tempDir();
  const db = openDatabase(join(dir, "db/test.sqlite"));
  return { dir, db };
};

const transcript = (path: string): SourceEntry => ({ kind: "claude-code/transcript", path });
const fileEntry = (path: string): SourceEntry => ({ kind: "claude-code/file", path });

const rawLines = (db: Database, path: string) =>
  db
    .query<{ line_no: number; raw: string; generation: number }, [string]>(
      "SELECT r.line_no, r.raw, s.generation FROM records r JOIN sources s ON s.id = r.source_id WHERE s.path = ? ORDER BY s.generation, r.line_no",
    )
    .all(path);

const userRecord = (n: number) => ({ type: "user", uuid: `u${n}`, sessionId: "s1", timestamp: `2026-10-14T00:00:0${n}Z`, message: { role: "user", content: `こんにちは${n}` } });

describe("importSources: line kinds", () => {
  test("imports every complete line with 1-based line numbers and identical text", () => {
    const { dir, db } = setup();
    const lines = [JSON.stringify(userRecord(1)), '{"type":"mode","mode":"x"}', JSON.stringify({ emoji: "🎉日本語" })];
    const path = writeFile(join(dir, "a.jsonl"), `${lines.join("\n")}\n`);
    const summary = importSources(db, [transcript(path)], {});
    expect(summary.recordsAdded).toBe(3);
    expect(rawLines(db, path)).toEqual(lines.map((raw, i) => ({ line_no: i + 1, raw, generation: 0 })));
  });

  test("imports only appended lines", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), jsonl(userRecord(1)));
    importSources(db, [transcript(path)], {});
    appendFileSync(path, jsonl(userRecord(2), userRecord(3)));
    const summary = importSources(db, [transcript(path)], {});
    expect(summary.recordsAdded).toBe(2);
    expect(rawLines(db, path).map((r) => r.line_no)).toEqual([1, 2, 3]);
  });

  test("is idempotent for unchanged files", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), jsonl(userRecord(1), userRecord(2)));
    importSources(db, [transcript(path)], {});
    const summary = importSources(db, [transcript(path)], {});
    expect(summary.recordsAdded).toBe(0);
    expect(rawLines(db, path)).toHaveLength(2);
  });

  test("defers a trailing partial line until its newline is written", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), `${JSON.stringify(userRecord(1))}\n{"type":"us`);
    importSources(db, [transcript(path)], {});
    expect(rawLines(db, path)).toHaveLength(1);
    appendFileSync(path, 'er"}\n');
    importSources(db, [transcript(path)], {});
    expect(rawLines(db, path).map((r) => r.raw)).toEqual([JSON.stringify(userRecord(1)), '{"type":"user"}']);
  });

  test("counts empty lines in line numbers across runs", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), '{"a":1}\n\n');
    importSources(db, [transcript(path)], {});
    appendFileSync(path, '{"a":3}\n');
    importSources(db, [transcript(path)], {});
    expect(rawLines(db, path).map((r) => r.line_no)).toEqual([1, 3]);
  });

  test("starts a new generation when the file shrank, keeping old records", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), jsonl(userRecord(1), userRecord(2)));
    importSources(db, [transcript(path)], {});
    writeFileSync(path, jsonl({ x: 1 }));
    importSources(db, [transcript(path)], {});
    expect(rawLines(db, path).map((r) => [r.generation, r.line_no])).toEqual([[0, 1], [0, 2], [1, 1]]);
  });

  test("starts a new generation when the head changed", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), jsonl({ a: 1 }));
    importSources(db, [transcript(path)], {});
    writeFileSync(path, jsonl({ b: 1 }, { b: 2 }));
    importSources(db, [transcript(path)], {});
    expect(rawLines(db, path).map((r) => [r.generation, r.raw])).toEqual([
      [0, '{"a":1}'],
      [1, '{"b":1}'],
      [1, '{"b":2}'],
    ]);
  });

  test("marks vanished sources as missing and clears the mark when they reappear", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), jsonl({ a: 1 }));
    importSources(db, [transcript(path)], { markMissing: true });
    rmSync(path);
    importSources(db, [], { markMissing: true });
    const missing = () => db.query<{ m: string | null }, [string]>("SELECT missing_since m FROM sources WHERE path = ?").get(path)?.m;
    expect(missing()).not.toBeNull();
    expect(rawLines(db, path)).toHaveLength(1);
    writeFile(path, jsonl({ a: 1 }));
    importSources(db, [transcript(path)], { markMissing: true });
    expect(missing()).toBeNull();
  });

  test("does not mark missing without the option", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), jsonl({ a: 1 }));
    importSources(db, [transcript(path)], {});
    importSources(db, [], {});
    expect(db.query("SELECT missing_since m FROM sources").get()).toEqual({ m: null });
  });

  test("stores invalid JSON lines with null generated columns", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), `not json\n${JSON.stringify(userRecord(1))}\n`);
    const summary = importSources(db, [transcript(path)], {});
    expect(summary.errors).toEqual([]);
    expect(db.query("SELECT raw, type, uuid FROM records ORDER BY line_no").all()).toEqual([
      { raw: "not json", type: null, uuid: null },
      { raw: JSON.stringify(userRecord(1)), type: "user", uuid: "u1" },
    ]);
  });
});

describe("importSources: file kinds", () => {
  const versions = (db: Database) => db.query<{ c: number }, []>("SELECT count(*) c FROM file_versions").get()?.c;
  const blobs = (db: Database) => db.query<{ c: number }, []>("SELECT count(*) c FROM blobs").get()?.c;

  test("adds versions only when the content changes and shares blobs", () => {
    const { dir, db } = setup();
    const a = writeFile(join(dir, "a.txt"), "one");
    const b = writeFile(join(dir, "b.txt"), "one");
    importSources(db, [fileEntry(a), fileEntry(b)], {});
    expect([versions(db), blobs(db)]).toEqual([2, 1]);
    importSources(db, [fileEntry(a)], {});
    expect(versions(db)).toBe(2);
    writeFileSync(a, "two");
    const summary = importSources(db, [fileEntry(a)], {});
    expect(summary.blobsAdded).toBe(1);
    expect([versions(db), blobs(db)]).toEqual([3, 2]);
    writeFileSync(a, "one");
    importSources(db, [fileEntry(a)], {});
    expect(versions(db)).toBe(3);
  });

  test("stores the content as bytes", () => {
    const { dir, db } = setup();
    const bytes = new Uint8Array([0, 255, 1, 2]);
    const a = writeFile(join(dir, "a.png"), bytes);
    importSources(db, [{ kind: "claude-desktop/session", path: a }], {});
    const row = db.query<{ content: Uint8Array }, []>("SELECT content FROM blobs").get();
    expect(new Uint8Array(row?.content ?? [])).toEqual(bytes);
  });
});

describe("messages view", () => {
  test("returns user and assistant records of transcripts", () => {
    const { dir, db } = setup();
    const assistant = { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "s1", timestamp: "2026-10-14T00:00:02Z", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }] } };
    const path = writeFile(join(dir, "a.jsonl"), jsonl(userRecord(1), { type: "mode", sessionId: "s1" }, assistant));
    const history = writeFile(join(dir, "history.jsonl"), jsonl({ type: "user", display: "x" }));
    importSources(db, [transcript(path), { kind: "claude-code/history", path: history }], {});
    const rows = db.query("SELECT session_id, uuid, parent_uuid, type, timestamp, role, model FROM messages ORDER BY timestamp").all();
    expect(rows).toEqual([
      { session_id: "s1", uuid: "u1", parent_uuid: null, type: "user", timestamp: "2026-10-14T00:00:01Z", role: "user", model: null },
      { session_id: "s1", uuid: "a1", parent_uuid: "u1", type: "assistant", timestamp: "2026-10-14T00:00:02Z", role: "assistant", model: "claude-opus-5-5" },
    ]);
  });
});

describe("database", () => {
  test("creates the database file with mode 0600", () => {
    const { dir } = setup();
    expect(statSync(join(dir, "db/test.sqlite")).mode & 0o777).toBe(0o600);
  });

  test("applies migrations up to the latest version once", () => {
    const { dir, db } = setup();
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
    db.close();
    const again = openDatabase(join(dir, "db/test.sqlite"));
    expect(again.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
  });

  test("records each run", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "a.jsonl"), jsonl({ a: 1 }, { a: 2 }));
    const f = writeFile(join(dir, "f.txt"), "x");
    importSources(db, [transcript(path), fileEntry(f)], {});
    importSources(db, [transcript(path)], {});
    expect(db.query("SELECT sources_seen, records_added, blobs_added, errors, finished_at IS NOT NULL done FROM runs ORDER BY id").all()).toEqual([
      { sources_seen: 2, records_added: 2, blobs_added: 1, errors: null, done: 1 },
      { sources_seen: 1, records_added: 0, blobs_added: 0, errors: null, done: 1 },
    ]);
  });
});

describe("claude-log-import CLI", () => {
  test("continues after an unreadable file, records the error and exits 1", () => {
    const dir = tempDir();
    const dbPath = join(dir, "c.sqlite");
    const bad = writeFile(join(dir, "bad.jsonl"), jsonl({ a: 1 }));
    chmodSync(bad, 0o000);
    const good = writeFile(join(dir, "good.jsonl"), jsonl({ a: 1 }));
    const input = `claude-code/transcript\t${bad}\nclaude-code/transcript\t${good}\n`;
    const result = Bun.spawnSync(["bun", join(repoRoot, "src/cli/import.ts"), "--db", dbPath], { stdin: Buffer.from(input) });
    chmodSync(bad, 0o600);
    expect(result.exitCode).toBe(1);
    const db = new Database(dbPath, { readonly: true });
    expect(rawLines(db, good)).toHaveLength(1);
    const errors = JSON.parse(db.query<{ errors: string }, []>("SELECT errors FROM runs").get()?.errors ?? "[]");
    expect(errors.map((e: { path: string }) => e.path)).toEqual([bad]);
  });

  test("uses AI_CHAT_LOGS_DB when --db is absent", () => {
    const dir = tempDir();
    const dbPath = join(dir, "env.sqlite");
    const good = writeFile(join(dir, "good.jsonl"), jsonl({ a: 1 }));
    const result = Bun.spawnSync(["bun", join(repoRoot, "src/cli/import.ts")], {
      stdin: Buffer.from(`claude-code/transcript\t${good}\n`),
      env: { ...process.env, AI_CHAT_LOGS_DB: dbPath },
    });
    expect(result.exitCode).toBe(0);
    expect(statSync(dbPath).isFile()).toBe(true);
  });

  test("defaults to the XDG data directory", () => {
    const dir = tempDir();
    const good = writeFile(join(dir, "good.jsonl"), jsonl({ a: 1 }));
    const env = { ...process.env, XDG_DATA_HOME: join(dir, "xdg") };
    delete env.AI_CHAT_LOGS_DB;
    const result = Bun.spawnSync(["bun", join(repoRoot, "src/cli/import.ts")], { stdin: Buffer.from(`claude-code/transcript\t${good}\n`), env });
    expect(result.exitCode).toBe(0);
    expect(statSync(join(dir, "xdg/ai-chat-logs/claude.sqlite")).isFile()).toBe(true);
  });

  test("reports unknown kinds as errors", () => {
    const dir = tempDir();
    const result = Bun.spawnSync(["bun", join(repoRoot, "src/cli/import.ts"), "--db", join(dir, "c.sqlite")], { stdin: Buffer.from("weird\t/x\n") });
    expect(result.exitCode).toBe(1);
  });
});

describe("importSources: chunked reads", () => {
  test("imports the same lines when reading in chunks smaller than a line", () => {
    const { dir, db } = setup();
    const lines = [JSON.stringify(userRecord(1)), "", '{"type":"日本語の長い行🎉🎉🎉🎉🎉🎉"}', JSON.stringify(userRecord(2))];
    const path = writeFile(join(dir, "a.jsonl"), `${lines.join("\n")}\n{"partial`);
    const summary = importSources(db, [transcript(path)], { chunkBytes: 7 });
    expect(summary.recordsAdded).toBe(3);
    expect(rawLines(db, path).map((r) => [r.line_no, r.raw])).toEqual([
      [1, lines[0]],
      [3, lines[2]],
      [4, lines[3]],
    ]);
    appendFileSync(path, '":1}\n');
    importSources(db, [transcript(path)], { chunkBytes: 7 });
    expect(rawLines(db, path).at(-1)).toEqual({ line_no: 5, raw: '{"partial":1}', generation: 0 });
  });
});
