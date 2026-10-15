import type { Kind } from "./kinds.ts";

// rel is relative to the Claude Code config directory, separated by "/".
export const classifyClaudeCodePath = (rel: string): Kind | null => {
  if (rel === "history.jsonl") return "claude-code/history";
  const parts = rel.split("/");
  if (parts[0] !== "projects" || parts.length < 3) return null;
  if (parts[2] === "memory") return null;
  const name = parts[parts.length - 1] ?? "";
  if (name.endsWith(".jsonl")) return "claude-code/transcript";
  if (parts.length === 3) return name.endsWith(".json") ? "claude-code/file" : null;
  return "claude-code/file";
};

// rel is relative to the desktop app directory.
export const classifyDesktopPath = (rel: string): Kind | null =>
  rel.startsWith("claude-code-sessions/") && rel.endsWith(".json") ? "claude-desktop/session" : null;
