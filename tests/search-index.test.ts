import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import initial from "../schema/0001-initial.sql" with { type: "text" };
import searchAndSummaries from "../schema/0002-search-and-summaries.sql" with { type: "text" };
import otherProviders from "../schema/0003-other-providers.sql" with { type: "text" };
import sessionMessageIndexes from "../schema/0004-session-message-indexes.sql" with { type: "text" };
import { openDatabase, SCHEMA_VERSION } from "../src/db.ts";
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

describe("duplicated records", () => {
  test("counts a record copied into another file once", () => {
    const { dir, db } = setup();
    const u = user("s", "写しの本文");
    const a = assistant("s", [{ type: "text", text: "答え" }]);
    const original = writeFile(join(dir, "a/s.jsonl"), jsonl(u, a));
    const copy = writeFile(join(dir, "b/fork.jsonl"), jsonl(u, a, assistant("s", [{ type: "text", text: "写しにだけある" }])));
    importSources(db, [transcript(original), transcript(copy)], {});
    expect(summary(db, "s")).toMatchObject({ message_count: 3 });
  });

  test("does not merge records without a uuid", () => {
    const { dir, db } = setup();
    const noUuid = { ...user("s", "uuid の無い本文"), uuid: undefined };
    const path = writeFile(join(dir, "s.jsonl"), jsonl(noUuid, noUuid));
    importSources(db, [transcript(path)], {});
    expect(summary(db, "s")).toMatchObject({ message_count: 2 });
  });
});

describe("other providers", () => {
  test("summarizes Cowork sessions with the desktop session title, ignoring audit lines", () => {
    const { dir, db } = setup();
    const t = writeFile(join(dir, "cw/s.jsonl"), jsonl(user("cw1", "Cowork の質問"), assistant("cw1", [{ type: "text", text: "Cowork の答え" }])));
    const meta = writeFile(join(dir, "local_1.json"), JSON.stringify({ cliSessionId: "cw1", title: "Cowork の題" }));
    const audit = writeFile(join(dir, "audit.jsonl"), jsonl({ type: "user", uuid: "x", session_id: "cw1", message: { role: "user", content: "監査の本文" } }));
    importSources(db, [
      { kind: "claude-cowork/transcript", path: t },
      { kind: "claude-cowork/session", path: meta },
      { kind: "claude-cowork/audit", path: audit },
    ], {});
    expect(db.query("SELECT * FROM session_summaries WHERE session_id = 'cw1'").get()).toMatchObject({
      provider: "claude-cowork",
      title: "Cowork の題",
      message_count: 2,
    });
    expect(texts(db)).toEqual(["Cowork の質問", "Cowork の答え"]);
  });

  test("summarizes claude.ai conversations and counts messages of repeated exports once", () => {
    const { dir, db } = setup();
    const lines = jsonl(
      { type: "custom-title", customTitle: "claude.ai の会話", sessionId: "c1" },
      user("c1", [{ type: "text", text: "claude.ai の質問" }]),
      assistant("c1", [{ type: "text", text: "claude.ai の答え" }]),
    );
    const first = writeFile(join(dir, "ai/aaaa/messages.jsonl"), lines);
    const second = writeFile(join(dir, "ai/bbbb/messages.jsonl"), lines);
    importSources(db, [
      { kind: "claude-ai/conversation", path: first },
      { kind: "claude-ai/conversation", path: second },
    ], {});
    expect(db.query("SELECT * FROM session_summaries WHERE session_id = 'c1'").get()).toMatchObject({
      provider: "claude-ai",
      title: "claude.ai の会話",
      message_count: 2,
    });
    expect(db.query("SELECT count(*) c FROM messages WHERE provider = 'claude-ai'").get()).toEqual({ c: 4 });
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

  test("migrating from version 2 keeps summaries and texts", () => {
    const dir = tempDir();
    const dbPath = join(dir, "v2.sqlite");
    const old = new Database(dbPath);
    old.run(initial);
    old.run(searchAndSummaries);
    old.run("PRAGMA user_version = 2");
    old.query("INSERT INTO sources (id, kind, path, first_seen_at, last_seen_at) VALUES (1, 'claude-code/transcript', '/x.jsonl', 'n', 'n')").run();
    old
      .query("INSERT INTO records (source_id, line_no, raw, imported_at, type, uuid, session_id, timestamp) VALUES (1, 1, ?, 'n', 'user', 'u', 's', 't')")
      .run(JSON.stringify(user("s", "版2の本文")));
    old.run("INSERT INTO record_texts (rowid, text) SELECT record_rowid, text FROM record_text_source WHERE text <> ''");
    old.run("INSERT INTO session_summaries SELECT * FROM session_summary_source");
    const before = old.query("SELECT * FROM session_summaries").all();
    old.close();
    const db = openDatabase(dbPath);
    expect(db.query("SELECT * FROM session_summaries").all()).toEqual(before);
    expect(texts(db)).toEqual(["版2の本文"]);
  });
});


// docs/adr/0017
describe("indexes for numbering session messages", () => {
  const indexes = (db: Database) =>
    db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'records' AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name);

  test("migrating from version 3 adds the covering indexes and drops records_uuid", () => {
    const dir = tempDir();
    const dbPath = join(dir, "v3.sqlite");
    const old = new Database(dbPath);
    old.run(initial);
    old.run(searchAndSummaries);
    old.run(otherProviders);
    old.run("PRAGMA user_version = 3");
    old.close();
    const db = openDatabase(dbPath);
    expect(db.query<{ v: number }, []>("SELECT user_version v FROM pragma_user_version").get()?.v).toBe(SCHEMA_VERSION);
    expect(indexes(db)).toEqual(["records_session", "records_session_order", "records_uuid_session"]);
  });

  test("session_messages drops the same copies as copied_records", () => {
    const { dir, db } = setup();
    const u = user("s", "原本");
    const a = assistant("s", [{ type: "text", text: "答え" }]);
    const noUuid = { ...user("s", "uuid の無い本文"), uuid: undefined };
    const original = writeFile(join(dir, "a/s.jsonl"), jsonl(u, a, noUuid, noUuid));
    const copy = writeFile(join(dir, "b/fork.jsonl"), jsonl(u, a, assistant("s", [{ type: "text", text: "写しにだけある" }])));
    const other = writeFile(join(dir, "c/t.jsonl"), jsonl({ ...u, sessionId: "t" }));
    importSources(db, [transcript(original), transcript(copy), transcript(other)], {});
    const rows = (sql: string) => db.query<{ record_rowid: number }, []>(sql).all().map((r) => r.record_rowid);
    const viaView = rows("SELECT record_rowid FROM session_messages ORDER BY record_rowid");
    const viaCopies = rows(
      `SELECT r.rowid record_rowid FROM records r JOIN sources s ON s.id = r.source_id
       WHERE s.kind = 'claude-code/transcript' AND r.type IN ('user', 'assistant') AND r.session_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM copied_records c WHERE c.record_rowid = r.rowid)
       ORDER BY r.rowid`,
    );
    expect(viaView).toEqual(viaCopies);
    expect(viaView.length).toBe(6);
  });

  test("numbering a session reads only the indexes of records", () => {
    const { db } = setup();
    const plan = db
      .query<{ detail: string }, []>(
        `EXPLAIN QUERY PLAN SELECT record_rowid, row_number() OVER (ORDER BY coalesce(timestamp, ''), path, generation, line_no)
         FROM session_messages WHERE provider = 'claude-code' AND session_id = 's'`,
      )
      .all()
      .map((r) => r.detail);
    expect(plan.filter((d) => /\b(SCAN|SEARCH) r2? /.test(d))).toEqual([
      expect.stringContaining("COVERING INDEX records_session_order"),
      expect.stringContaining("COVERING INDEX records_uuid_session"),
    ]);
  });
});

// docs/adr/0021
describe("tool texts", () => {
  const toolTexts = (db: Database) =>
    db.query<{ text: string }, []>("SELECT text FROM record_tool_texts ORDER BY rowid").all().map((r) => r.text);
  const toolUse = assistant("s", [
    { type: "text", text: "編集します" },
    { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "docs/x.md", new_string: "編集の中身" } },
  ]);
  const stringResult = user("s", [{ type: "tool_result", tool_use_id: "t1", content: "結果の文字列" }]);
  const arrayResult = user("s", [
    { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "配列の文字" }, { type: "image", source: { type: "base64", data: "QUJDREVG" } }] },
  ]);

  test("migrating from version 4 builds record_tool_texts from existing records", () => {
    const dir = tempDir();
    const dbPath = join(dir, "v4.sqlite");
    const old = new Database(dbPath);
    [initial, searchAndSummaries, otherProviders, sessionMessageIndexes].forEach((sql) => old.run(sql));
    old.run("PRAGMA user_version = 4");
    old.query("INSERT INTO sources (id, kind, path, first_seen_at, last_seen_at) VALUES (1, 'claude-code/transcript', '/x.jsonl', 'n', 'n')").run();
    old
      .query("INSERT INTO records (source_id, line_no, raw, imported_at, type, uuid, session_id, timestamp) VALUES (1, 1, ?, 'n', 'assistant', 'a', 's', 't')")
      .run(JSON.stringify(toolUse));
    old.close();
    const db = openDatabase(dbPath);
    expect(db.query<{ v: number }, []>("SELECT user_version v FROM pragma_user_version").get()?.v).toBe(5);
    expect(toolTexts(db)).toEqual([`Edit ${JSON.stringify(toolUse.message.content[1]?.input)}`]);
  });

  test("tool inputs, string results and the text parts of array results, without images or plain messages", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "s.jsonl"), jsonl(user("s", "ツールの無い本文"), toolUse, stringResult, arrayResult));
    importSources(db, [transcript(path)], {});
    const found = toolTexts(db);
    expect(found).toHaveLength(3);
    expect(found[0]).toContain("編集の中身");
    expect(found.slice(1)).toEqual(["結果の文字列", "配列の文字"]);
    expect(found.join("\n")).not.toContain("QUJDREVG");
  });

  test("an import adds the tool texts of the new lines", () => {
    const { dir, db } = setup();
    const path = writeFile(join(dir, "s.jsonl"), jsonl(toolUse));
    importSources(db, [transcript(path)], {});
    appendFileSync(path, jsonl(stringResult));
    importSources(db, [transcript(path)], {});
    expect(toolTexts(db)).toHaveLength(2);
  });
});
