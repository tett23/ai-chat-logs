import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { importSources } from "../src/import.ts";
import { restoredRaw } from "../src/payloads.ts";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

// docs/adr/0031: chat-log reads records with payloads as if nothing had been taken out.
const dir = tempDir();
const withPayloads = join(dir, "payloads.sqlite");
const without = join(dir, "plain.sqlite");
const P = "pppppppp-1234";
const RESULT = `ツールの結果の先頭 ${"r ".repeat(2500)}末尾`;
const PNG = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 31) % 256)).toString("base64");
const rec = (uuid: string, timestamp: string, role: string, content: unknown) => ({
  type: role, uuid, sessionId: P, timestamp, cwd: "/work/pay", message: { role, content },
});

beforeAll(() => {
  const db = openDatabase(withPayloads);
  const path = writeFile(join(dir, "p.jsonl"), jsonl(
    rec("p1", "2026-11-01T00:00:00.000Z", "user", "ペイロードの確認"),
    rec("p2", "2026-11-01T00:01:00.000Z", "assistant", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/x", content: `書く中身 ${"w".repeat(4000)}` } }]),
    rec("p3", "2026-11-01T00:02:00.000Z", "user", [{ type: "tool_result", tool_use_id: "t1", content: RESULT }]),
    rec("p4", "2026-11-01T00:03:00.000Z", "user", [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: `配列の結果 ${"a".repeat(2000)}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }]),
  ));
  importSources(db, [{ kind: "claude-code/transcript", path }], {});
  db.close();
  // The same database with every record restored in place, as if nothing had been taken out.
  copyFileSync(withPayloads, without);
  const plain = new Database(without);
  const restore = restoredRaw(plain);
  plain
    .query<{ rowid: number; raw: string; payload_state: number | null }, []>("SELECT rowid, raw, payload_state FROM records")
    .all()
    .forEach((r) => plain.run("UPDATE records SET raw = ?, payload_state = 0 WHERE rowid = ?", [restore(r.raw, r.payload_state), r.rowid]));
  plain.close();
});

const chatLog = (db: string, args: string[]) => {
  const r = Bun.spawnSync([join(repoRoot, "src/cli/chat-log.ts"), ...args], { env: isolatedEnv({ HOME: dir, AI_CHAT_LOGS_DB: db }) });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

describe("chat-log with payloads", () => {
  test("the test database holds payloads", () => {
    const db = new Database(withPayloads, { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM records WHERE payload_state = 1").get()?.n).toBe(3);
    db.close();
  });

  test.each([
    [["show", P, "--tools", "--max-chars", "0"]],
    [["show", P, "--json", "--tools", "--max-chars", "0"]],
    [["export", P]],
    [["context", "--cwd", "/work/pay"]],
    [["search", "ツールの結果の先頭", "--tools"]],
  ])("%p prints the same as without payloads", (args) => {
    const a = chatLog(withPayloads, args);
    const b = chatLog(without, args);
    expect(a.code).toBe(0);
    expect(a.out).toBe(b.out);
    expect(a.out).not.toContain("ai-chat-logs-payload");
  });

  test("export holds the whole tool result", () => {
    expect(chatLog(withPayloads, ["export", P]).out).toContain(RESULT);
  });

  test("a database of version 5 exits 2", () => {
    const oldPath = join(tempDir(), "v5.sqlite");
    const old = openDatabase(oldPath);
    old.run("PRAGMA user_version = 5");
    old.close();
    const r = chatLog(oldPath, ["sessions"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("bin/sync");
  });
});
