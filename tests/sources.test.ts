import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isolatedEnv, repoRoot, tempDir, writeFile } from "./helpers.ts";

const runSources = (env: Record<string, string>, cwd?: string) =>
  Bun.spawnSync([join(repoRoot, "src/cli/sources.ts")], { env: isolatedEnv(env), cwd });

describe("claude-log-sources", () => {
  test("prints the kind and the absolute path of each source", () => {
    const home = tempDir();
    const config = join(home, "config");
    const desktop = join(home, "Library/Application Support/Claude");
    const expected = [
      ["claude-code/history", writeFile(join(config, "history.jsonl"), "")],
      ["claude-code/transcript", writeFile(join(config, "projects/p/s.jsonl"), "")],
      ["claude-code/transcript", writeFile(join(config, "projects/p/s/subagents/a.jsonl"), "")],
      ["claude-code/file", writeFile(join(config, "projects/p/s/tool-results/t.txt"), "")],
      ["claude-desktop/session", writeFile(join(desktop, "claude-code-sessions/a/b/local_1.json"), "{}")],
    ];
    writeFile(join(config, "projects/p/memory/MEMORY.md"), "");
    writeFile(join(config, "settings.json"), "{}");

    const result = runSources({ HOME: home, CLAUDE_CONFIG_DIR: config });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.toString().trim().split("\n").sort();
    expect(lines).toEqual(expected.map(([k, p]) => `${k}\t${p}`).sort());
  });

  test("defaults the config directory to ~/.claude", () => {
    const home = tempDir();
    const path = writeFile(join(home, ".claude/history.jsonl"), "");
    const result = runSources({ HOME: home });
    expect(result.stdout.toString()).toBe(`claude-code/history\t${path}\n`);
  });

  test("prints nothing when no directory exists", () => {
    const home = tempDir();
    const result = runSources({ HOME: home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  test("reads CLAUDE_CONFIG_DIR from the env file", () => {
    const home = tempDir();
    const path = writeFile(join(home, "conf/history.jsonl"), "");
    const envFile = writeFile(join(home, "my.env"), `CLAUDE_CONFIG_DIR=${join(home, "conf")}\n`);
    const result = runSources({ HOME: home, AI_CHAT_LOGS_ENV_FILE: envFile });
    expect(result.stdout.toString()).toBe(`claude-code/history\t${path}\n`);
  });

  test("does not read .env in the working directory", () => {
    const home = tempDir();
    const cwd = tempDir();
    writeFile(join(home, "conf/history.jsonl"), "");
    writeFile(join(cwd, ".env"), `CLAUDE_CONFIG_DIR=${join(home, "conf")}\n`);
    const result = runSources({ HOME: home }, cwd);
    expect(result.stdout.toString()).toBe("");
  });

  test("exits 2 on a malformed env file", () => {
    const home = tempDir();
    const envFile = writeFile(join(home, "bad.env"), "OK=1\nnot valid\n");
    const result = runSources({ HOME: home, AI_CHAT_LOGS_ENV_FILE: envFile });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(`${envFile}: line 2`);
  });

  test("lists Cowork sessions and converted claude.ai exports", () => {
    const home = tempDir();
    const session = join(home, "Library/Application Support/Claude/local-agent-mode-sessions/a/b/local_1");
    const aiDir = join(home, "ai");
    const expected = [
      ["claude-cowork/session", writeFile(`${session}.json`, "{}")],
      ["claude-cowork/audit", writeFile(join(session, "audit.jsonl"), "")],
      ["claude-cowork/transcript", writeFile(join(session, ".claude/projects/p/s.jsonl"), "")],
      ["claude-ai/conversation", writeFile(join(aiDir, "0123456789abcdef/messages.jsonl"), "")],
      ["claude-ai/export", writeFile(join(aiDir, "0123456789abcdef/conversations.json"), "[]")],
    ];
    writeFile(join(session, "uploads/a.pdf"), "x");
    writeFile(join(session, "outputs/b.md"), "x");
    const result = runSources({ HOME: home, AI_CHAT_LOGS_CLAUDE_AI_DIR: aiDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n").sort()).toEqual(expected.map(([k, p]) => `${k}\t${p}`).sort());
  });

  test("defaults the claude.ai directory under XDG_DATA_HOME and reads it from the env file", () => {
    const home = tempDir();
    const byDefault = writeFile(join(home, "data/ai-chat-logs/claude-ai/x/messages.jsonl"), "");
    expect(runSources({ HOME: home, XDG_DATA_HOME: join(home, "data") }).stdout.toString()).toBe(`claude-ai/conversation\t${byDefault}\n`);
    const fromEnv = writeFile(join(home, "elsewhere/y/messages.jsonl"), "");
    const envFile = writeFile(join(home, "my.env"), `AI_CHAT_LOGS_CLAUDE_AI_DIR=${join(home, "elsewhere")}\n`);
    expect(runSources({ HOME: home, AI_CHAT_LOGS_ENV_FILE: envFile }).stdout.toString()).toBe(`claude-ai/conversation\t${fromEnv}\n`);
  });
});
