#!/usr/bin/env -S bun --no-env-file
// ADR 0038: import the transcript named by the PreCompact event.
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { classifyClaudeCodePath } from "../classify.ts";
import { codexSnapshotSources, saveCodexSnapshot } from "../codex-store.ts";
import { openDatabase } from "../db.ts";
import { loadEnvFile } from "../env.ts";
import { importSources, type SourceEntry } from "../import.ts";
import { claudeConfigDir, codexDir, codexStore, defaultDatabasePath } from "../paths.ts";

try {
  loadEnvFile(1);
  const provider = process.argv[2];
  if (process.argv.length !== 3 || (provider !== "codex" && provider !== "claude-code")) {
    throw new Error("usage: ai-chat-logs-precompact codex|claude-code");
  }
  const event = JSON.parse(await Bun.stdin.text());
  if (event?.hook_event_name !== "PreCompact") throw new Error("expected a PreCompact event");
  if (typeof event.transcript_path !== "string" || !isAbsolute(event.transcript_path)) {
    throw new Error("expected an absolute transcript_path");
  }
  const path = resolve(event.transcript_path);
  const root = resolve(provider === "codex" ? codexDir(process.env) : claudeConfigDir(process.env));
  const rel = relative(root, path);
  const allowed = provider === "codex"
    ? /^(sessions|archived_sessions)\/.+\.jsonl$/.test(rel)
    : classifyClaudeCodePath(rel) === "claude-code/transcript";
  if (!allowed || !lstatSync(path).isFile() || realpathSync(path) !== join(realpathSync(root), rel)) {
    throw new Error("transcript_path is outside the allowed transcripts or is not a regular file");
  }

  let sources: SourceEntry[];
  const errors: string[] = [];
  if (provider === "codex") {
    const snapshot = saveCodexSnapshot(path, resolve(codexStore(process.env)));
    sources = codexSnapshotSources(snapshot.directory);
    if (snapshot.manifest.status !== 0) {
      errors.push(...(snapshot.warnings.length ? snapshot.warnings : ["snapshot has conversion warnings"]));
    }
  } else {
    sources = [{ kind: "claude-code/transcript", path }];
  }
  const db = openDatabase(defaultDatabasePath(process.env));
  try {
    const result = importSources(db, sources, {});
    errors.push(...result.errors.map(({ path, message }) => `${path}: ${message}`));
  } finally {
    db.close();
  }
  if (errors.length) throw new Error(errors.join("\n"));
} catch (error) {
  console.error("ai-chat-logs-precompact:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
