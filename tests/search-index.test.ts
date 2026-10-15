import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import initial from "../schema/0001-initial.sql" with { type: "text" };
import { openDatabase } from "../src/db.ts";
import { importSources, type SourceEntry } from "../src/import.ts";
import { jsonl, tempDir, writeFile } from "./helpers.ts";

const setup = () => {
  const dir = tempDir();
  return { dir, db: openDatabase(join(dir, "t.sqlite")) };
};
const transcript = (path: string): SourceEntry => ({ kind: "claude-code/transcript", path });

let seq = 0;
const ts = () => `2026-10-14T00:00:${String(seq++ % 60).padStart(2, "0")}.000Z`;
const user = (sessionId: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: `u${seq}`,
  sessionId,
  timestamp: ts(),
  cwd: "/work/p",
  message: { role: "user", content },
  ...extra,
});
const assistant = (sessionId: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  uuid: `a${seq}`,
  sessionId,
  timestamp: ts(),
  cwd: "/work/p",
  message: { role: "assistant", model: "claude-opus-5-5", content },
  ...extra,
});

const texts = (db: Database) =>
  db.query<{ text: string }, []>("SELECT text FROM record_texts ORDER BY rowid").all().map((r) => r.text);
const summary = (db: Database, sessionId: string) =>
  db.query("SELECT * FROM session_summaries WHERE provider = 'claude-code' AND session_id = ?").get(sessionId);

describe("record_texts", () => {
  test("extracts text from strings and text/thinking blocks, skipping tool blocks", () => {
    const { dir, db } = setup();
    const path = writeFile(
      join(dir, "s.jsonl"),
      jsonl(
        user("s", "文字列の本文"),
        assistant("s", [
          { type: "thinking", thinking: "考え中の内容" },
          { type: "text", text: "返答の本文" },
          { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } },
        ]),
        user("s", [{ type: "tool_result", tool_use_id: "t", content: "結果は索引に入らない" }]),
        assistant("s", [{ type: "tool_use", id: "t2", name: "Read", input: {} }]),
      ),
    );
    importSources(db, [transcript(path)], {});
    expect(texts(db)).toEqual(["文字列の本文", "考え中の内容\n返答の本文"]);
  });

  test("finds Japanese three-character terms with MATCH and skips other records and history", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "s.jsonl"), jsonl(user("s", "全文検索のテスト"), { type: "custom-title", customTitle: "全文検索のタイトル", sessionId: "s" }));
    const history = writeFile(join(dir, "history.jsonl"), jsonl({ display: "全文検索の履歴", timestamp: 1, sessionId: "s" }));
    importSources(db, [transcript(path), { kind: "claude-code/history", path: history }], {});
    const hits = db.query<{ text: string }, [string]>("SELECT text FROM record_texts WHERE record_texts MATCH ?").all('"文検索"');
    expect(hits.map((h) => h.text)).toEqual(["全文検索のテスト"]);
  });

  test("adds only the appended records", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "s.jsonl"), jsonl(user("s", "一つ目の本文")));
    importSources(db, [transcript(path)], {});
    appendFileSync(path, jsonl(assistant("s", [{ type: "text", text: "二つ目の本文" }])));
    importSources(db, [transcript(path)], {});
    importSources(db, [transcript(path)], {});
    expect(texts(db)).toEqual(["一つ目の本文", "二つ目の本文"]);
  });
});

describe("session_summaries", () => {
  test("counts messages and records the first and last times and the first cwd", () => {
    const { dir, db } = setup();
    const u = user("s1", "最初の質問", { cwd: "/work/first" });
    const a = assistant("s1", [{ type: "text", text: "答え" }], { cwd: "/work/second" });
    const sub = assistant("s1", [{ type: "text", text: "サブ" }], { isSidechain: true });
    const main = writeFile(join(dir, "s1.jsonl"), jsonl({ type: "mode", sessionId: "s1" }, u, a));
    const agent = writeFile(join(dir, "s1/subagents/agent-1.jsonl"), jsonl(sub));
    importSources(db, [transcript(main), transcript(agent)], {});
    expect(summary(db, "s1")).toEqual({
      provider: "claude-code",
      session_id: "s1",
      cwd: "/work/first",
      title: "最初の質問",
      first_at: u.timestamp,
      last_at: sub.timestamp,
      message_count: 3,
    });
  });

  test("does not summarize sessions without messages", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "s.jsonl"), jsonl({ type: "mode", sessionId: "empty" }, { type: "custom-title", customTitle: "x", sessionId: "empty" }));
    importSources(db, [transcript(path)], {});
    expect(summary(db, "empty")).toBeNull();
  });

  test("uses the last custom title", () => {
    const { dir, db } = setup();
    const path = writeFile(
      join(dir, "s.jsonl"),
      jsonl(user("s", "本文"), { type: "custom-title", customTitle: "古い", sessionId: "s" }, { type: "custom-title", customTitle: "新しい", sessionId: "s" }),
    );
    importSources(db, [transcript(path)], {});
    expect(summary(db, "s")).toMatchObject({ title: "新しい" });
  });

  test("falls back to the desktop session title and follows its updates", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "s.jsonl"), jsonl(user("cli-1", "本文")));
    const desktop = writeFile(join(dir, "local_1.json"), JSON.stringify({ cliSessionId: "cli-1", title: "デスクトップの題" }));
    const entries: SourceEntry[] = [transcript(path), { kind: "claude-desktop/session", path: desktop }];
    importSources(db, entries, {});
    expect(summary(db, "cli-1")).toMatchObject({ title: "デスクトップの題" });
    writeFileSync(desktop, JSON.stringify({ cliSessionId: "cli-1", title: "変えた題" }));
    importSources(db, [{ kind: "claude-desktop/session", path: desktop }], {});
    expect(summary(db, "cli-1")).toMatchObject({ title: "変えた題" });
  });

  test("falls back to the first 80 characters of the first non-meta user text", () => {
    const { dir, db } = setup();
    const long = "あ".repeat(100);
    const path = writeFile(join(dir, "s.jsonl"), jsonl(user("s", "メタの本文", { isMeta: true }), user("s", [{ type: "text", text: long }])));
    importSources(db, [transcript(path)], {});
    expect(summary(db, "s")).toMatchObject({ title: "あ".repeat(80) });
  });
});

describe("migration", () => {
  test("builds record_texts and session_summaries from existing records", () => {
    const dir = tempDir();
    const dbPath = join(dir, "old.sqlite");
    const old = new Database(dbPath);
    old.run(initial);
    old.run("PRAGMA user_version = 1");
    old.query("INSERT INTO sources (id, kind, path, first_seen_at, last_seen_at) VALUES (1, 'claude-code/transcript', '/x.jsonl', 'n', 'n')").run();
    const insert = old.query(
      "INSERT INTO records (source_id, line_no, raw, imported_at, type, uuid, session_id, timestamp) VALUES (1, ?, ?, 'n', 'user', ?, 's', ?)",
    );
    insert.run(1, JSON.stringify(user("s", "既存の本文")), "u-old", "2026-01-01T00:00:00.000Z");
    old.close();

    const db = openDatabase(dbPath);
    expect(texts(db)).toEqual(["既存の本文"]);
    expect(summary(db, "s")).toMatchObject({ message_count: 1, title: "既存の本文" });
  });
});
