import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, repoRoot, tempDir, writeFile } from "./helpers.ts";

// docs/adr/0010
const conversations = (uuid: string) =>
  JSON.stringify([{ uuid, name: `会話 ${uuid}`, created_at: "2026-01-01T00:00:00Z", chat_messages: [{ uuid: `${uuid}-m`, sender: "human", text: "本文" }] }]);

// A zip of `files` (relative path -> content) at `zipPath`.
const makeZip = (zipPath: string, files: Record<string, string>): string => {
  const src = tempDir();
  Object.entries(files).forEach(([rel, content]) => writeFile(join(src, rel), content));
  mkdirSync(join(zipPath, ".."), { recursive: true });
  expect(Bun.spawnSync(["zip", "-q", "-r", zipPath, "."], { cwd: src }).exitCode).toBe(0);
  return zipPath;
};

const setup = () => {
  const home = tempDir();
  return { home, inbox: join(home, "inbox"), aiDir: join(home, "ai") };
};

const scan = (env: Record<string, string | undefined>) =>
  Bun.spawnSync([join(repoRoot, "src/cli/claude-ai-export-scan.ts")], { env: isolatedEnv(env) });

const scanIn = ({ home, inbox, aiDir }: ReturnType<typeof setup>) =>
  scan({ HOME: home, AI_CHAT_LOGS_CLAUDE_AI_INBOX: inbox, AI_CHAT_LOGS_CLAUDE_AI_DIR: aiDir });

const outputs = (r: ReturnType<typeof scan>) => r.stdout.toString().trim().split("\n").filter((l) => l !== "");
const converted = (aiDir: string) => (existsSync(aiDir) ? readdirSync(aiDir).sort() : []);

describe("claude-ai-export-scan", () => {
  test("converts exports with conversations.json at the root or one level down", () => {
    const s = setup();
    makeZip(join(s.inbox, "conversations-000.zip"), { "conversations.json": conversations("a") });
    makeZip(join(s.inbox, "nested.zip"), { "data/conversations.json": conversations("b"), "data/projects.json": "[]" });
    const r = scanIn(s);
    expect(r.exitCode).toBe(0);
    const out = outputs(r);
    expect(out).toHaveLength(2);
    out.forEach((dir) => expect(existsSync(join(dir, "messages.jsonl"))).toBe(true));
    expect(converted(s.aiDir)).toHaveLength(2);
    expect(out.some((dir) => existsSync(join(dir, "projects.json")))).toBe(true);
  });

  test("recognizes exports by content, not by name, and skips other zips", () => {
    const s = setup();
    makeZip(join(s.inbox, "renamed export.zip"), { "conversations.json": conversations("a") });
    makeZip(join(s.inbox, "photos.zip"), { "a.txt": "x" });
    expect(outputs(scanIn(s))).toHaveLength(1);
  });

  test("ignores subdirectories and files that are not zips", () => {
    const s = setup();
    makeZip(join(s.inbox, "deeper/conversations-000.zip"), { "conversations.json": conversations("a") });
    writeFile(join(s.inbox, "conversations.json"), conversations("b"));
    const r = scanIn(s);
    expect(r.exitCode).toBe(0);
    expect(outputs(r)).toEqual([]);
    expect(converted(s.aiDir)).toEqual([]);
  });

  test("does not convert imported exports again, nor the same export twice", () => {
    const s = setup();
    makeZip(join(s.inbox, "one.zip"), { "conversations.json": conversations("a") });
    makeZip(join(s.inbox, "copy.zip"), { "conversations.json": conversations("a") });
    expect(outputs(scanIn(s))).toHaveLength(1);
    const again = scanIn(s);
    expect(again.exitCode).toBe(0);
    expect(outputs(again)).toEqual([]);
    expect(converted(s.aiDir)).toHaveLength(1);
  });

  test("converts split exports into separate directories", () => {
    const s = setup();
    makeZip(join(s.inbox, "conversations-000.zip"), { "conversations.json": conversations("a") });
    makeZip(join(s.inbox, "conversations-001.zip"), { "conversations.json": conversations("b") });
    expect(outputs(scanIn(s))).toHaveLength(2);
    expect(converted(s.aiDir)).toHaveLength(2);
  });

  test("continues after a broken zip or invalid JSON and exits 1", () => {
    const s = setup();
    writeFile(join(s.inbox, "broken.zip"), "PK\u0003\u0004 not really a zip");
    makeZip(join(s.inbox, "bad-json.zip"), { "conversations.json": "{oops" });
    makeZip(join(s.inbox, "good.zip"), { "conversations.json": conversations("a") });
    const r = scanIn(s);
    expect(r.exitCode).toBe(1);
    expect(outputs(r)).toHaveLength(1);
    expect(r.stderr.toString()).toContain("bad-json.zip");
  });

  test("does nothing when the inbox does not exist", () => {
    const s = setup();
    const r = scanIn(s);
    expect(r.exitCode).toBe(0);
    expect(outputs(r)).toEqual([]);
  });

  test("defaults the inbox to ~/Downloads and reads it from the .env and config files", () => {
    const { home, aiDir } = setup();
    makeZip(join(home, "Downloads/x.zip"), { "conversations.json": conversations("d") });
    expect(outputs(scan({ HOME: home, AI_CHAT_LOGS_CLAUDE_AI_DIR: aiDir }))).toHaveLength(1);

    const viaEnv = setup();
    makeZip(join(viaEnv.home, "elsewhere/x.zip"), { "conversations.json": conversations("e") });
    const envFile = writeFile(join(viaEnv.home, "my.env"), `AI_CHAT_LOGS_CLAUDE_AI_INBOX=${join(viaEnv.home, "elsewhere")}\n`);
    expect(outputs(scan({ HOME: viaEnv.home, AI_CHAT_LOGS_CLAUDE_AI_DIR: viaEnv.aiDir, AI_CHAT_LOGS_ENV_FILE: envFile }))).toHaveLength(1);

    const viaConfig = setup();
    makeZip(join(viaConfig.home, "conf-inbox/x.zip"), { "conversations.json": conversations("f") });
    const config = writeFile(join(viaConfig.home, "config.env"), `AI_CHAT_LOGS_CLAUDE_AI_INBOX=${join(viaConfig.home, "conf-inbox")}\n`);
    expect(outputs(scan({ HOME: viaConfig.home, AI_CHAT_LOGS_CLAUDE_AI_DIR: viaConfig.aiDir, AI_CHAT_LOGS_CONFIG: config }))).toHaveLength(1);
  });
});
