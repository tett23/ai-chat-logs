import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { classifyCodexSource, codexDisplayTitle, encryptedBlockIndexes } from "../src/codex-presentation.ts";
import { convertCodexLines } from "../src/codex.ts";
import { openDatabase } from "../src/db.ts";
import { importSources } from "../src/import.ts";
import { jsonl, tempDir, writeFile } from "./helpers.ts";

const meta = (id: string, source: unknown = "cli") => ({ type: "session_meta", payload: { id, source } });
const message = (id: string, text: string, role = "user") => ({ type: "response_item", payload: { type: "message", id, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const snapshot = (root: string, rows: unknown[]) => {
  const raw = jsonl(...rows);
  const hash = createHash("sha256").update(raw).digest("hex");
  const rollout = writeFile(join(root, hash, "rollout.jsonl"), raw);
  const conversation = writeFile(join(root, hash, "messages-v1.jsonl"), convertCodexLines(rows.map(JSON.stringify)).messages);
  return [{ kind: "codex/rollout", path: rollout }, { kind: "codex/conversation", path: conversation }];
};

describe("Codex presentation", () => {
  test("V2 source classification uses only known first source shapes", () => {
    expect(classifyCodexSource("cli").category).toBe("normal");
    expect(classifyCodexSource("vscode").category).toBe("normal");
    expect(classifyCodexSource({ subagent: { thread_spawn: { parent_thread_id: "p", agent_path: "a", agent_nickname: "n", agent_role: "r" } } })).toMatchObject({ category: "subagent", parent_thread_id: "p", agent_role: "r" });
    expect(classifyCodexSource({ subagent: { other: "guardian" } })).toMatchObject({ category: "internal", detail: "guardian" });
    expect(classifyCodexSource({ subagent: { other: "guardian", thread_spawn: {} } }).category).toBe("unknown");
    expect(classifyCodexSource("future").category).toBe("unknown");
    expect(classifyCodexSource(null).category).toBe("unknown");
  });

  test("V3 strips complete leading instructions, preserves incomplete text and counts code points", () => {
    const instruction = "# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>";
    expect(codexDisplayTitle("s", [message("a", `${instruction}\n本題`)])).toBe("本題");
    expect(codexDisplayTitle("s", [message("a", "# AGENTS.md instructions\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>\n\n<environment_context>cwd</environment_context>\n本題")])).toBe("本題");
    expect(codexDisplayTitle("s", [message("a", instruction), message("b", "次の依頼")])).toBe("次の依頼");
    expect(codexDisplayTitle("s", [message("a", "# AGENTS.md instructions\n<INSTRUCTIONS>open")])).toBe("# AGENTS.md instructions <INSTRUCTIONS>open");
    expect(codexDisplayTitle("s", [message("a", `> ${instruction}`)])).toStartWith("> # AGENTS.md instructions");
    expect(codexDisplayTitle("s", [message("a", "😀".repeat(81))])).toBe("😀".repeat(80));
    expect(codexDisplayTitle("s", [message("a", "")])).toBe("s");
    const split = { type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "# AGENTS.md instructions" }, { type: "input_text", text: "<INSTRUCTIONS>rules</INSTRUCTIONS>" }, { type: "input_text", text: "依頼" },
    ] } };
    expect(codexDisplayTitle("s", [split])).toBe("依頼");
  });

  test("V4 only original encrypted block positions are reported", () => {
    expect(encryptedBlockIndexes({ type: "reasoning", summary: [{ type: "summary_text", text: "公開" }], encrypted_content: "cipher" })).toEqual([1]);
    expect(encryptedBlockIndexes({ type: "message", role: "user", content: [{ type: "input_text", text: "暗号化された内容は表示できない" }, { type: "encrypted_content", encrypted_content: "cipher" }] })).toEqual([1]);
    expect(encryptedBlockIndexes({ type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "cipher" }] })).toEqual([0]);
    expect(encryptedBlockIndexes({ type: "message", role: "user", content: [{ type: "input_text", text: "暗号化された内容は表示できない" }] })).toEqual([]);
  });

  test("V1 V2 V4 V6 import builds additive deterministic metadata from all snapshots", () => {
    const root = tempDir(), db = openDatabase(join(root, "db.sqlite"));
    const old = [meta("s", { subagent: { thread_spawn: { parent_thread_id: "parent", agent_role: "worker" } } }), message("u", "old")];
    const newer = [...old, meta("s", "cli"), message("task", "# AGENTS.md instructions\n<INSTRUCTIONS>x</INSTRUCTIONS>\n実際の依頼"),
      { type: "response_item", payload: { type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "公開" }], encrypted_content: "secret" } },
      message("plain", "暗号化された内容は表示できない", "assistant")];
    const entries = [...snapshot(root, newer), ...snapshot(root, old)];
    const before = db.query<{ n: number }, []>("SELECT count(*) n FROM records").get()?.n;
    const result = importSources(db, entries, {});
    expect(result.errors).toEqual([]);
    const preserved = db.query<{ n: number }, []>("SELECT count(*) n FROM records").get()?.n;
    const row = db.query<{ category: string; display_title: string; parent_thread_id: string; snapshot_sha256: string }, []>("SELECT category, display_title, parent_thread_id, snapshot_sha256 FROM codex_session_presentation WHERE session_id='s'").get();
    expect(row).toMatchObject({ category: "subagent", display_title: "old", parent_thread_id: "parent" });
    expect(row?.snapshot_sha256).toBe(createHash("sha256").update(jsonl(...newer)).digest("hex"));
    const masks = db.query<{ encrypted_block_indexes: string }, []>("SELECT encrypted_block_indexes FROM codex_item_presentation").all();
    expect(masks.map((m) => JSON.parse(m.encrypted_block_indexes))).toContainEqual([1]);
    expect(masks).toHaveLength(1);
    expect(importSources(db, entries, {}).errors).toEqual([]);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM records").get()?.n).toBe(preserved);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM codex_item_presentation").get()?.n).toBe(1);
    expect(preserved).toBeGreaterThan(before as number);
    db.close();
  });

  test("V1 schema 7 migration preserves existing records, FTS and summaries", () => {
    const root = tempDir(), path = join(root, "legacy.sqlite"), legacy = new Database(path);
    for (let i = 1; i <= 7; i++) {
      const name = ["initial", "search-and-summaries", "other-providers", "session-message-indexes", "tool-texts", "payloads", "codex-conversations"][i - 1];
      legacy.run(readFileSync(join(import.meta.dir, `../schema/${String(i).padStart(4, "0")}-${name}.sql`), "utf8"));
      legacy.run(`PRAGMA user_version = ${i}`);
    }
    legacy.query("INSERT INTO sources(kind,path,first_seen_at,last_seen_at) VALUES ('codex/conversation','legacy','t','t')").run();
    legacy.query("INSERT INTO records(source_id,line_no,raw,imported_at,type,uuid,session_id) VALUES (1,1,?,'t','user','u','s')")
      .run(JSON.stringify({ type: "user", uuid: "u", sessionId: "s", message: { content: [{ type: "text", text: "公開" }] } }));
    legacy.query("INSERT INTO record_texts(rowid,text) VALUES (1,'公開')").run();
    legacy.query("INSERT INTO session_summaries(provider,session_id,title,message_count) VALUES ('codex','s','old',1)").run();
    const before = ["records", "record_texts", "session_summaries"].map((table) => JSON.stringify(legacy.query(`SELECT * FROM ${table}`).all()));
    legacy.close();
    const db = openDatabase(path);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(8);
    expect(["records", "record_texts", "session_summaries"].map((table) => JSON.stringify(db.query(`SELECT * FROM ${table}`).all()))).toEqual(before);
    expect(importSources(db, [], {}).errors).toEqual([]);
    expect(db.query<{ category: string; display_title: string }, []>("SELECT category,display_title FROM codex_session_presentation WHERE session_id='s'").get())
      .toMatchObject({ category: "unknown", display_title: "old" });
    expect(["records", "record_texts", "session_summaries"].map((table) => JSON.stringify(db.query(`SELECT * FROM ${table}`).all()))).toEqual(before);
    db.close();
  });

  test("V4 stored agent_message masks encrypted block after the v1 author prefix", () => {
    const root = tempDir(), db = openDatabase(join(root, "db.sqlite"));
    const rows = [meta("agent", { subagent: { thread_spawn: { parent_thread_id: "parent" } } }),
      { type: "response_item", payload: { type: "agent_message", id: "a", author: "worker", recipient: "parent", content: [
        { type: "output_text", text: "公開部分" },
        { type: "encrypted_content", encrypted_content: "cipher" },
        { type: "output_text", text: "暗号化された内容は表示できない" },
      ] } }];
    expect(importSources(db, snapshot(root, rows), {}).errors).toEqual([]);
    const converted = db.query<{ raw: string }, []>("SELECT r.raw FROM records r JOIN sources s ON s.id=r.source_id WHERE s.kind='codex/conversation' AND r.type='assistant'").get();
    expect(JSON.parse(converted?.raw as string).message.content.map((block: { text: string }) => block.text)).toEqual([
      "[worker → parent] 公開部分", "[worker → parent] 暗号化された内容は表示できない", "[worker → parent] 暗号化された内容は表示できない",
    ]);
    const mask = db.query<{ encrypted_block_indexes: string }, []>("SELECT encrypted_block_indexes FROM codex_item_presentation WHERE session_id='agent'").get();
    expect(JSON.parse(mask?.encrypted_block_indexes as string)).toEqual([1]);
    db.close();
  });

  test("V6 failed conversation update rolls back and the next import retries", () => {
    const root = tempDir(), db = openDatabase(join(root, "db.sqlite"));
    const rows = [meta("s"), { type: "response_item", payload: { type: "reasoning", id: "r", encrypted_content: "cipher" } }];
    const entries = snapshot(root, rows);
    db.run("CREATE TRIGGER fail_mask BEFORE INSERT ON codex_item_presentation BEGIN SELECT RAISE(FAIL, 'injected failure'); END");
    expect(importSources(db, entries, {}).errors).toHaveLength(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM codex_session_presentation").get()?.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM codex_item_presentation").get()?.n).toBe(0);
    db.run("DROP TRIGGER fail_mask");
    expect(importSources(db, [], {}).errors).toEqual([]);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM codex_item_presentation").get()?.n).toBe(1);
    db.close();
  });
});
