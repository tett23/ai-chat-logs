import { Database } from "bun:sqlite";
import { openDatabase } from "../src/db.ts";
import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { importSources } from "../src/import.ts";
import { listCodexSources } from "../src/codex-store.ts";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

const claudeMessage = (id: string, text: string) => ({
  type: "user", uuid: id, sessionId: "claude-session", timestamp: "2026-11-13T00:00:00Z",
  message: { role: "user", content: text },
});

const codexLines = (text: string) => jsonl(
  { type: "session_meta", payload: { id: "codex-session", cwd: "/repo" } },
  { type: "response_item", timestamp: "2026-11-13T00:00:00Z",
    payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text }] } },
);

const setup = () => {
  const home = tempDir();
  const dbPath = join(home, "logs.sqlite");
  const store = join(home, "codex-store");
  const env = isolatedEnv({ HOME: home, AI_CHAT_LOGS_DB: dbPath, AI_CHAT_LOGS_CODEX_STORE: store });
  const run = (provider: "claude-code" | "codex", path?: string, trigger: "manual" | "auto" = "manual", extraEnv: Record<string, string> = {}) =>
    Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/precompact"), provider], {
      env: { ...env, ...extraEnv },
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "PreCompact", transcript_path: path, trigger })),
    });
  const search = (provider: "claude-code" | "codex", phrase: string) =>
    Bun.spawnSync(["bun", join(repoRoot, "src/cli/chat-log.ts"), "search", phrase, "--provider", provider], { env });
  return { home, dbPath, store, env, run, search };
};

const sourceRow = (db: Database, path: string) =>
  db.query<{ consumed_bytes: number; consumed_lines: number; missing_since: string | null }, [string]>(
    "SELECT consumed_bytes, consumed_lines, missing_since FROM sources WHERE path = ? ORDER BY generation DESC LIMIT 1",
  ).get(path);

describe("ADR 0038 pre-compaction capture", () => {
  for (const trigger of ["manual", "auto"] as const) {
    test(`H1 H2 Claude Code ${trigger} imports complete lines once and resumes at the same byte offset`, () => {
      const f = setup();
      const first = jsonl(claudeMessage("u1", "first complete"));
      const next = jsonl(claudeMessage("u2", "second complete"));
      const path = writeFile(join(f.home, ".claude/projects/-repo/session.jsonl"), first + next.slice(0, 12));
      const one = f.run("claude-code", path, trigger);
      expect(one.exitCode).toBe(0);
      expect(one.stdout.toString()).toBe("");
      const db = new Database(f.dbPath);
      expect(sourceRow(db, path)?.consumed_bytes).toBe(Buffer.byteLength(first));
      expect(db.query("SELECT raw FROM records").all()).toEqual([{ raw: first.trimEnd() }]);
      expect(f.run("claude-code", path, trigger).exitCode).toBe(0);
      expect(db.query("SELECT count(*) AS n FROM records").get()).toEqual({ n: 1 });
      appendFileSync(path, next.slice(12));
      expect(f.run("claude-code", path, trigger).exitCode).toBe(0);
      expect(sourceRow(db, path)?.consumed_bytes).toBe(Buffer.byteLength(first + next));
      expect(db.query("SELECT count(*) AS n FROM records").get()).toEqual({ n: 2 });
      const search = f.search("claude-code", "second complete");
      expect(search.exitCode).toBe(0);
      expect(search.stdout.toString()).toContain("claude-s#2");
      expect(importSources(db, [{ kind: "claude-code/transcript", path }], {}).recordsAdded).toBe(0);
      db.close();
    });

    test(`H1 H2 Codex ${trigger} stores a complete-byte snapshot once`, () => {
      const f = setup();
      const complete = codexLines("saved before compaction");
      const path = writeFile(join(f.home, ".codex/sessions/2026/11/13/session.jsonl"), complete + '{"partial":');
      const one = f.run("codex", path, trigger);
      expect(one.exitCode).toBe(0);
      expect(one.stdout.toString()).toBe("");
      const sources = listCodexSources(f.store);
      expect(sources.map((source) => source.kind)).toEqual(["codex/conversation", "codex/rollout"]);
      expect(readFileSync(sources.find((source) => source.kind === "codex/rollout")!.path).toString()).toBe(complete);
      const db = new Database(f.dbPath);
      const before = db.query("SELECT count(*) AS n FROM session_messages WHERE provider = 'codex'").get();
      expect(before).toEqual({ n: 1 });
      const search = f.search("codex", "saved before compaction");
      expect(search.exitCode).toBe(0);
      expect(search.stdout.toString()).toContain("saved before compaction");
      expect(f.run("codex", path, trigger).exitCode).toBe(0);
      expect(readdirSync(f.store)).toHaveLength(1);
      expect(db.query("SELECT count(*) AS n FROM session_messages WHERE provider = 'codex'").get()).toEqual(before);
      expect(Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync-codex")], { env: f.env }).exitCode).toBe(0);
      expect(db.query("SELECT count(*) AS n FROM session_messages WHERE provider = 'codex'").get()).toEqual(before);
      db.close();
    });
  }

  test("H1 H2 empty inputs and a prior periodic Claude import remain idempotent", () => {
    const f = setup();
    const claude = writeFile(join(f.home, ".claude/projects/-repo/empty.jsonl"), "");
    const codex = writeFile(join(f.home, ".codex/archived_sessions/empty.jsonl"), "");
    expect(f.run("claude-code", claude).exitCode).toBe(0);
    expect(f.run("codex", codex).exitCode).toBe(0);
    const db = new Database(f.dbPath);
    expect(sourceRow(db, claude)?.consumed_bytes).toBe(0);
    expect(readFileSync(listCodexSources(f.store).find((source) => source.kind === "codex/rollout")!.path)).toHaveLength(0);
    db.close();

    const data = jsonl(claudeMessage("periodic", "periodic first"));
    writeFile(claude, data);
    const imported = openDatabase(f.dbPath);
    expect(importSources(imported, [{ kind: "claude-code/transcript", path: claude }], {}).recordsAdded).toBe(1);
    expect(f.run("claude-code", claude).exitCode).toBe(0);
    expect(imported.query("SELECT count(*) AS n FROM records WHERE source_id = (SELECT id FROM sources WHERE path = ?)").get(claude)).toEqual({ n: 1 });
    imported.close();
  });

  test("H2 Codex periodic import followed by hook keeps one searchable message", () => {
    const f = setup();
    const path = writeFile(join(f.home, ".codex/sessions/2026/11/13/periodic.jsonl"), codexLines("periodic then hook"));
    expect(Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync-codex")], { env: f.env }).exitCode).toBe(0);
    const db = new Database(f.dbPath);
    const before = db.query("SELECT count(*) AS n FROM session_messages WHERE provider = 'codex'").get();
    expect(before).toEqual({ n: 1 });
    expect(f.run("codex", path).exitCode).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM session_messages WHERE provider = 'codex'").get()).toEqual(before);
    expect(f.search("codex", "periodic then hook").stdout.toString()).toContain("periodic then hook");
    db.close();
  });

  test("H4 an unwritable database path reports a failure without blocking compaction", () => {
    const f = setup();
    const path = writeFile(join(f.home, ".claude/projects/-repo/session.jsonl"), jsonl(claudeMessage("u1", "db failure")));
    const result = f.run("claude-code", path, "manual", { AI_CHAT_LOGS_DB: f.home });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString().length).toBeGreaterThan(0);
  });

  test("H3 only the target source changes its missing state", () => {
    const f = setup();
    const other = writeFile(join(f.home, ".claude/projects/-other/other.jsonl"), jsonl(claudeMessage("other", "other session")));
    const target = writeFile(join(f.home, ".claude/projects/-repo/session.jsonl"), jsonl(claudeMessage("target", "target session")));
    const db = openDatabase(f.dbPath);
    importSources(db, [{ kind: "claude-code/transcript", path: other }], {});
    db.run("UPDATE sources SET missing_since = '2026-01-01' WHERE path = ?", [other]);
    expect(f.run("claude-code", target).exitCode).toBe(0);
    expect(sourceRow(db, other)?.missing_since).toBe("2026-01-01");
    db.close();
  });

  test("H4 missing, external and symlink paths report failure without blocking compaction", () => {
    const f = setup();
    const outside = writeFile(join(f.home, "outside.jsonl"), jsonl(claudeMessage("x", "outside")));
    const linked = join(f.home, ".claude/projects/-repo/link.jsonl");
    writeFile(join(f.home, ".claude/projects/-repo/placeholder"), "");
    symlinkSync(outside, linked);
    for (const [provider, path] of [
      ["claude-code", undefined],
      ["claude-code", outside],
      ["claude-code", linked],
      ["codex", outside],
    ] as const) {
      const result = f.run(provider, path);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
  });
});
