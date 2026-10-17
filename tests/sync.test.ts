import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

describe("bin/sync", () => {
  test("lists and imports sources into the database", () => {
    const home = tempDir();
    writeFile(join(home, ".claude/projects/p/s.jsonl"), jsonl({ type: "user", sessionId: "s" }, { type: "assistant", sessionId: "s" }));
    writeFile(join(home, ".claude/history.jsonl"), jsonl({ display: "x" }));
    writeFile(join(home, ".claude/projects/p/s/tool-results/t.txt"), "out");
    const dbPath = join(home, "out.sqlite");
    const result = Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], {
      env: isolatedEnv({ HOME: home, AI_CHAT_LOGS_DB: dbPath }),
    });
    expect(result.exitCode).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT count(*) c FROM records").get()).toEqual({ c: 3 });
    expect(db.query("SELECT count(*) c FROM blobs").get()).toEqual({ c: 1 });
  });

  test("exits 127 when bun is not in PATH", () => {
    const result = Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env: isolatedEnv({ PATH: "/usr/bin:/bin", HOME: tempDir() }) });
    expect(result.exitCode).toBe(127);
    expect(result.stderr.toString()).toContain("bun");
  });

  test("does not mark sources missing when listing fails", () => {
    const home = tempDir();
    const path = writeFile(join(home, ".claude/projects/p/s.jsonl"), jsonl({ a: 1 }));
    const dbPath = join(home, "out.sqlite");
    const env = isolatedEnv({ HOME: home, AI_CHAT_LOGS_DB: dbPath });
    expect(Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env }).exitCode).toBe(0);
    // a config dir that cannot be read makes the listing fail
    const broken = Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env: { ...env, CLAUDE_CONFIG_DIR: join(dirname(path), "s.jsonl") } });
    expect(broken.exitCode).not.toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT missing_since m FROM sources").get()).toEqual({ m: null });
  });

  test("imports into AI_CHAT_LOGS_DB from the env file", () => {
    const home = tempDir();
    writeFile(join(home, ".claude/history.jsonl"), jsonl({ display: "x" }));
    const dbPath = join(home, "from-env.sqlite");
    const envFile = writeFile(join(home, "my.env"), `AI_CHAT_LOGS_DB=${dbPath}\n`);
    const result = Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env: isolatedEnv({ HOME: home, AI_CHAT_LOGS_ENV_FILE: envFile }) });
    expect(result.exitCode).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT count(*) c FROM records").get()).toEqual({ c: 1 });
  });

  test("converts claude.ai exports in the inbox before importing (docs/adr/0010)", () => {
    const home = tempDir();
    const src = tempDir();
    writeFile(
      join(src, "conversations.json"),
      JSON.stringify([{ uuid: "c1", name: "受け取った会話", created_at: "2026-01-01T00:00:00Z", chat_messages: [{ uuid: "m1", sender: "human", text: "本文" }] }]),
    );
    mkdirSync(join(home, "Downloads"));
    expect(Bun.spawnSync(["zip", "-q", "-r", join(home, "Downloads/conversations-000.zip"), "."], { cwd: src }).exitCode).toBe(0);
    const dbPath = join(home, "out.sqlite");
    const result = Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env: isolatedEnv({ HOME: home, AI_CHAT_LOGS_DB: dbPath }) });
    expect(result.exitCode).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT title FROM session_summaries WHERE provider = 'claude-ai'").get()).toEqual({ title: "受け取った会話" });
  });

  test("still imports when scanning fails, and exits 1", () => {
    const home = tempDir();
    writeFile(join(home, "Downloads/broken.zip"), "PK\u0003\u0004 broken");
    writeFile(join(home, ".claude/history.jsonl"), jsonl({ display: "x" }));
    const dbPath = join(home, "out.sqlite");
    const result = Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env: isolatedEnv({ HOME: home, AI_CHAT_LOGS_DB: dbPath }) });
    expect(result.exitCode).toBe(1);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT count(*) c FROM records").get()).toEqual({ c: 1 });
  });
});

