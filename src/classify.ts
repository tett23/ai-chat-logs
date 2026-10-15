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

// docs/adr/0006: a Cowork session's own Claude Code config directory, relative to its projects/.
const classifyCoworkProjects = (parts: readonly string[]): Kind | null => {
  if (parts.length < 2 || parts[1] === "memory") return null;
  const name = parts[parts.length - 1] ?? "";
  if (name.endsWith(".jsonl")) return "claude-cowork/transcript";
  return parts.length >= 3 ? "claude-cowork/file" : null;
};

// local-agent-mode-sessions/<id>/<id>/...
const classifyCowork = (parts: readonly string[]): Kind | null => {
  const [, , , entry, ...rest] = parts;
  if (entry === undefined || !entry.startsWith("local_")) return null;
  if (rest.length === 0) return entry.endsWith(".json") ? "claude-cowork/session" : null;
  if (rest.length === 1 && rest[0] === "audit.jsonl") return "claude-cowork/audit";
  if (rest[0] === ".claude" && rest[1] === "projects") return classifyCoworkProjects(rest.slice(2));
  return null;
};

// rel is relative to the desktop app directory.
export const classifyDesktopPath = (rel: string): Kind | null => {
  if (rel.startsWith("claude-code-sessions/")) return rel.endsWith(".json") ? "claude-desktop/session" : null;
  const parts = rel.split("/");
  return parts[0] === "local-agent-mode-sessions" ? classifyCowork(parts) : null;
};

const EXPORT_FILES = new Set(["conversations.json", "projects.json", "users.json"]);

// docs/adr/0006: rel is relative to the claude.ai directory: <export id>/<file>.
export const classifyClaudeAiPath = (rel: string): Kind | null => {
  const parts = rel.split("/");
  if (parts.length !== 2) return null;
  const name = parts[1] ?? "";
  if (name === "messages.jsonl") return "claude-ai/conversation";
  return EXPORT_FILES.has(name) ? "claude-ai/export" : null;
};
