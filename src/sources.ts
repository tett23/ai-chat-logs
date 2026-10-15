import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { classifyClaudeCodePath, classifyDesktopPath } from "./classify.ts";
import type { Kind } from "./kinds.ts";
import { claudeConfigDir, desktopAppDir } from "./paths.ts";

export type Source = { kind: Kind; path: string };

const isNotFound = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

// Files under dir, recursively, without following symlinks. A missing dir yields nothing.
const walk = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(entry.parentPath, entry.name);
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
    });
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
};

const classifyUnder = (root: string, classify: (rel: string) => Kind | null): Source[] =>
  walk(root).flatMap((path) => {
    const kind = classify(relative(root, path).split(sep).join("/"));
    return kind ? [{ kind, path }] : [];
  });

const historyFile = (config: string): Source[] => {
  const path = join(config, "history.jsonl");
  try {
    return statSync(path).isFile() ? [{ kind: "claude-code/history", path }] : [];
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
};

const byPath = (a: Source, b: Source): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export const listSources = (env: Record<string, string | undefined>): Source[] => {
  const config = claudeConfigDir(env);
  return [
    ...historyFile(config),
    ...classifyUnder(join(config, "projects"), (rel) => classifyClaudeCodePath(`projects/${rel}`)),
    ...classifyUnder(join(desktopAppDir(env), "claude-code-sessions"), (rel) => classifyDesktopPath(`claude-code-sessions/${rel}`)),
  ].sort(byPath);
};
