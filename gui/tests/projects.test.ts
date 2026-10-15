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
});
