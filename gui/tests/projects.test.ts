import { describe, expect, test } from "bun:test";
import { projectOptions, providerLabel } from "../src/projects.ts";

describe("projectOptions", () => {
  test("lists Claude Code projects by cwd and other providers as one entry each", () => {
    expect(
      projectOptions([
        { provider: "claude-ai", cwd: null, session_count: 3 },
        { provider: "claude-code", cwd: "/work/a", session_count: 2 },
        { provider: "claude-cowork", cwd: "/x/outputs", session_count: 1 },
        { provider: "claude-cowork", cwd: "/y/outputs", session_count: 4 },
        { provider: "claude-code", cwd: null, session_count: 1 },
      ]),
    ).toEqual([
      { label: "claude.ai（3）", filter: { provider: "claude-ai", cwd: null } },
      { label: "/work/a（2）", filter: { provider: "claude-code", cwd: "/work/a" } },
      { label: "Cowork（5）", filter: { provider: "claude-cowork", cwd: null } },
    ]);
  });
});

describe("providerLabel", () => {
  test("names known providers and keeps unknown ones", () => {
    expect(providerLabel("claude-ai")).toBe("claude.ai");
    expect(providerLabel("claude-cowork")).toBe("Cowork");
    expect(providerLabel("claude-code")).toBe("Claude Code");
    expect(providerLabel("other")).toBe("other");
  });
  test("I1 names Codex and keeps the three Claude sources distinct", () => {
    expect(["claude-code", "claude-ai", "claude-cowork", "codex"].map(providerLabel)).toEqual([
      "Claude Code", "claude.ai", "Cowork", "Codex",
    ]);
  });
});

test("I2 lists Codex projects by cwd and keeps missing cwd selectable", () => {
  expect(projectOptions([
    { provider: "claude-code", cwd: "/work", session_count: 1 },
    { provider: "codex", cwd: "/work", session_count: 2 },
    { provider: "codex", cwd: null, session_count: 3 },
    { provider: "codex", cwd: "/other", session_count: 4 },
  ])).toEqual([
    { label: "/work（1）", filter: { provider: "claude-code", cwd: "/work" } },
    { label: "Codex / /work（2）", filter: { provider: "codex", cwd: "/work" } },
    { label: "Codex / 作業ディレクトリなし（3）", filter: { provider: "codex", cwd: null, cwd_missing: true } },
    { label: "Codex / /other（4）", filter: { provider: "codex", cwd: "/other" } },
  ]);
});
