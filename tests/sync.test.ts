import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

describe("bin/sync", () => {
  test("lists and imports sources into the database", () => {
    const home = tempDir();
    writeFile(join(home, ".claude/projects/p/s.jsonl"), jsonl({ type: "user", sessionId: "s" }, { type: "assistant", sessionId: "s" }));
    writeFile(join(home, ".claude/history.jsonl"), jsonl({ display: "x" }));
    writeFile(join(home, ".claude/projects/p/s/tool-results/t.txt"), "out");
    const dbPath = join(home, "out.sqlite");
    const result = Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], {
      env: { PATH: process.env.PATH ?? "", HOME: home, AI_CHAT_LOGS_DB: dbPath },
    });
    expect(result.exitCode).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT count(*) c FROM records").get()).toEqual({ c: 3 });
    expect(db.query("SELECT count(*) c FROM blobs").get()).toEqual({ c: 1 });
  });

  test("exits 127 when bun is not in PATH", () => {
    const result = Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env: { PATH: "/usr/bin:/bin", HOME: tempDir() } });
    expect(result.exitCode).toBe(127);
    expect(result.stderr.toString()).toContain("bun");
  });

  test("does not mark sources missing when listing fails", () => {
    const home = tempDir();
    const path = writeFile(join(home, ".claude/projects/p/s.jsonl"), jsonl({ a: 1 }));
    const dbPath = join(home, "out.sqlite");
    const env = { PATH: process.env.PATH ?? "", HOME: home, AI_CHAT_LOGS_DB: dbPath };
    expect(Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env }).exitCode).toBe(0);
    // a config dir that cannot be read makes the listing fail
    const broken = Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env: { ...env, CLAUDE_CONFIG_DIR: join(dirname(path), "s.jsonl") } });
    expect(broken.exitCode).not.toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT missing_since m FROM sources").get()).toEqual({ m: null });
  });
});
