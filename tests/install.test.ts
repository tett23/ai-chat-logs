import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { accessSync, constants, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

// docs/adr/0008
const NAMES = ["claude-log-sources", "chat-log-import", "claude-ai-export-convert", "claude-ai-export-scan", "chat-log", "ai-chat-logs-sync"];
const prefix = join(tempDir(), "bin");
const builtRepo = tempDir();
const install = () =>
  Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/install"), prefix], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AI_CHAT_LOGS_REPO_AT_BUILD: builtRepo },
  });

let first: ReturnType<typeof install>;
beforeAll(() => {
  first = install();
}, 120_000);

const run = (name: string, env: Record<string, string | undefined>, cwd?: string, args: string[] = []) =>
  Bun.spawnSync([join(prefix, name), ...args], { env: isolatedEnv(env), cwd });

describe("bin/install", () => {
  test("installs the executables and the sync script and prints their paths", () => {
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString().trim().split("\n")).toEqual(NAMES.map((n) => join(prefix, n)));
    NAMES.forEach((n) => accessSync(join(prefix, n), constants.X_OK));
  });

  test("the installed claude-log-sources lists the history of HOME", () => {
    const home = tempDir();
    const path = writeFile(join(home, ".claude/history.jsonl"), "");
    expect(run("claude-log-sources", { HOME: home }).stdout.toString()).toBe(`claude-code/history\t${path}\n`);
  });

  test("does not read .env in the working directory", () => {
    const home = tempDir();
    const cwd = tempDir();
    writeFile(join(home, "conf/history.jsonl"), "");
    writeFile(join(cwd, ".env"), `CLAUDE_CONFIG_DIR=${join(home, "conf")}\n`);
    expect(run("claude-log-sources", { HOME: home }, cwd).stdout.toString()).toBe("");
  });

  test("reads the .env of the repository embedded at build time", () => {
    const home = tempDir();
    const path = writeFile(join(home, "conf/history.jsonl"), "");
    const envFile = writeFile(join(builtRepo, ".env"), `CLAUDE_CONFIG_DIR=${join(home, "conf")}\n`);
    const env = isolatedEnv({ HOME: home });
    delete env.AI_CHAT_LOGS_ENV_FILE;
    const result = Bun.spawnSync([join(prefix, "claude-log-sources")], { env });
    rmSync(envFile);
    expect(result.stdout.toString()).toBe(`claude-code/history\t${path}\n`);
  });

  test("reads the config file", () => {
    const home = tempDir();
    const path = writeFile(join(home, "conf/history.jsonl"), "");
    const config = writeFile(join(home, "config.env"), `CLAUDE_CONFIG_DIR=${join(home, "conf")}\n`);
    expect(run("claude-log-sources", { HOME: home, AI_CHAT_LOGS_CONFIG: config }).stdout.toString()).toBe(
      `claude-code/history\t${path}\n`,
    );
  });

  test("ai-chat-logs-sync imports with only the install directory on PATH", () => {
    const home = tempDir();
    writeFile(join(home, ".claude/projects/p/s.jsonl"), jsonl({ type: "user", sessionId: "s" }));
    const dbPath = join(home, "out.sqlite");
    const result = run("ai-chat-logs-sync", { PATH: `${prefix}:/usr/bin:/bin`, HOME: home, AI_CHAT_LOGS_DB: dbPath });
    expect(result.exitCode).toBe(0);
    expect(new Database(dbPath, { readonly: true }).query("SELECT count(*) c FROM records").get()).toEqual({ c: 1 });
  });

  test("ai-chat-logs-sync converts exports in the inbox (docs/adr/0010)", () => {
    const home = tempDir();
    const src = tempDir();
    writeFile(
      join(src, "conversations.json"),
      JSON.stringify([{ uuid: "c1", name: "n", created_at: "2026-01-01T00:00:00Z", chat_messages: [{ uuid: "m1", sender: "human", text: "t" }] }]),
    );
    mkdirSync(join(home, "Downloads"));
    expect(Bun.spawnSync(["zip", "-q", "-r", join(home, "Downloads/e.zip"), "."], { cwd: src }).exitCode).toBe(0);
    const dbPath = join(home, "out.sqlite");
    const result = run("ai-chat-logs-sync", { PATH: `${prefix}:/usr/bin:/bin`, HOME: home, AI_CHAT_LOGS_DB: dbPath });
    expect(result.exitCode).toBe(0);
    expect(new Database(dbPath, { readonly: true }).query("SELECT count(*) c FROM session_summaries WHERE provider = 'claude-ai'").get()).toEqual({ c: 1 });
  });

  test("the installed chat-log reads the database (docs/adr/0011)", () => {
    const home = tempDir();
    writeFile(join(home, ".claude/projects/p/s.jsonl"), jsonl({ type: "user", uuid: "u", sessionId: "abcdefgh-1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "インストールの確認" } }));
    const dbPath = join(home, "out.sqlite");
    run("ai-chat-logs-sync", { PATH: `${prefix}:/usr/bin:/bin`, HOME: home, AI_CHAT_LOGS_DB: dbPath });
    const r = run("chat-log", { HOME: home, AI_CHAT_LOGS_DB: dbPath }, undefined, ["search", "インストール"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("abcdefgh#1");
  });

  test("installs again over the existing files", () => {
    const again = install();
    expect(again.exitCode).toBe(0);
    expect(run("claude-log-sources", { HOME: tempDir() }).exitCode).toBe(0);
  }, 120_000);
});
