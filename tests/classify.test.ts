import { describe, expect, test } from "bun:test";
import { classifyClaudeAiPath, classifyClaudeCodePath, classifyDesktopPath } from "../src/classify.ts";

describe("classifyClaudeCodePath", () => {
  test("history.jsonl", () => {
    expect(classifyClaudeCodePath("history.jsonl")).toBe("claude-code/history");
  });

  test("session transcripts", () => {
    expect(classifyClaudeCodePath("projects/p/s.jsonl")).toBe("claude-code/transcript");
  });

  test("subagent transcripts", () => {
    expect(classifyClaudeCodePath("projects/p/s/subagents/agent-a.jsonl")).toBe("claude-code/transcript");
  });

  test("excludes memory", () => {
    expect(classifyClaudeCodePath("projects/p/memory/MEMORY.md")).toBeNull();
    expect(classifyClaudeCodePath("projects/p/memory/x.jsonl")).toBeNull();
  });

  test("files under a session directory", () => {
    expect(classifyClaudeCodePath("projects/p/s/tool-results/a.txt")).toBe("claude-code/file");
    expect(classifyClaudeCodePath("projects/p/s/custom-title.json")).toBe("claude-code/file");
    expect(classifyClaudeCodePath("projects/p/s/image.png")).toBe("claude-code/file");
  });

  test("json files directly under a project directory", () => {
    expect(classifyClaudeCodePath("projects/p/s.desktop-released.json")).toBe("claude-code/file");
  });

  test("other files directly under a project directory are excluded", () => {
    expect(classifyClaudeCodePath("projects/p/notes.txt")).toBeNull();
  });

  test("files outside projects are excluded", () => {
    expect(classifyClaudeCodePath("settings.json")).toBeNull();
    expect(classifyClaudeCodePath("sessions/a.jsonl")).toBeNull();
    expect(classifyClaudeCodePath("projects/x.jsonl")).toBeNull();
  });
});

describe("classifyDesktopPath", () => {
  test("session json files", () => {
    expect(classifyDesktopPath("claude-code-sessions/a/b/local_x.json")).toBe("claude-desktop/session");
  });

  test("excludes other files", () => {
    expect(classifyDesktopPath("claude-code-sessions/a/b/deleted_x")).toBeNull();
    expect(classifyDesktopPath("config.json")).toBeNull();
  });
});

describe("classifyDesktopPath: Cowork", () => {
  const base = "local-agent-mode-sessions/acc/org";
  const session = `${base}/local_1`;

  test("session metadata", () => {
    expect(classifyDesktopPath(`${base}/local_1.json`)).toBe("claude-cowork/session");
  });

  test("audit log", () => {
    expect(classifyDesktopPath(`${session}/audit.jsonl`)).toBe("claude-cowork/audit");
  });

  test("transcripts including subagents", () => {
    expect(classifyDesktopPath(`${session}/.claude/projects/p/s.jsonl`)).toBe("claude-cowork/transcript");
    expect(classifyDesktopPath(`${session}/.claude/projects/p/s/subagents/a.jsonl`)).toBe("claude-cowork/transcript");
  });

  test("files under a session directory", () => {
    expect(classifyDesktopPath(`${session}/.claude/projects/p/s/tool-results/t.txt`)).toBe("claude-cowork/file");
  });

  test("excludes everything else", () => {
    [
      `${session}/uploads/a.pdf`,
      `${session}/outputs/b.md`,
      `${session}/.claude/settings.json`,
      `${session}/.claude/sessions/x.json`,
      `${session}/.claude/projects/p/memory/MEMORY.md`,
      `${session}/.claude/projects/p/notes.txt`,
      `${base}/memory/CLAUDE.md`,
      `${base}/cowork-gb-cache.json`,
      `${base}/scheduled-tasks.json`,
      `${base}/rpm/manifest.json`,
      "local-agent-mode-sessions/skills-plugin/org/acc/x.json",
    ].forEach((rel) => expect([rel, classifyDesktopPath(rel)]).toEqual([rel, null]));
  });
});

describe("classifyClaudeAiPath", () => {
  test("converted messages and export files", () => {
    expect(classifyClaudeAiPath("0123456789abcdef/messages.jsonl")).toBe("claude-ai/conversation");
    expect(classifyClaudeAiPath("0123456789abcdef/conversations.json")).toBe("claude-ai/export");
    expect(classifyClaudeAiPath("0123456789abcdef/projects.json")).toBe("claude-ai/export");
    expect(classifyClaudeAiPath("0123456789abcdef/users.json")).toBe("claude-ai/export");
  });

  test("excludes other files", () => {
    expect(classifyClaudeAiPath("messages.jsonl")).toBeNull();
    expect(classifyClaudeAiPath("x/other.json")).toBeNull();
    expect(classifyClaudeAiPath("x/y/messages.jsonl")).toBeNull();
  });
});

