import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, tempDir, writeFile } from "./helpers.ts";

const runSources = (env: Record<string, string>) =>
  Bun.spawnSync(["bun", join(repoRoot, "src/cli/sources.ts")], { env: { PATH: process.env.PATH ?? "", ...env } });

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
});
