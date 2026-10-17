#!/usr/bin/env -S bun --no-env-file
// docs/adr/0006: copy a claude.ai export and convert it to messages.jsonl for chat-log-import.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXPORT_FILES, storeExport } from "../claude-ai-store.ts";
import { loadEnvFile } from "../env.ts";
import { claudeAiDir } from "../paths.ts";

loadEnvFile();

const fail = (message: string): never => {
  console.error(`claude-ai-export-convert: ${message}`);
  process.exit(1);
};

// The directory holding conversations.json: the given one or one level below it.
const exportDir = (dir: string): string | null => {
  if (existsSync(join(dir, "conversations.json"))) return dir;
  const child = readdirSync(dir, { withFileTypes: true }).find(
    (e) => e.isDirectory() && existsSync(join(dir, e.name, "conversations.json")),
  );
  return child ? join(dir, child.name) : null;
};

const unzip = (zip: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "claude-ai-export-"));
  const result = Bun.spawnSync(["unzip", "-q", zip, "-d", dir]);
  if (result.exitCode !== 0) fail(`failed to unzip ${zip}: ${result.stderr.toString().trim()}`);
  return dir;
};

const input = process.argv[2] ?? fail("usage: claude-ai-export-convert <zip | directory | conversations.json>");
if (!existsSync(input)) fail(`not found: ${input}`);

const temp = input.endsWith(".zip") ? unzip(input) : null;
try {
  const root = temp ?? (statSync(input).isDirectory() ? input : dirname(input));
  const source = exportDir(root) ?? fail(`conversations.json not found in ${input}`);
  const files = Object.fromEntries(
    EXPORT_FILES.filter((name) => existsSync(join(source, name))).map((name) => [name, readFileSync(join(source, name))]),
  ) as Parameters<typeof storeExport>[1];
  const out = (() => {
    try {
      return storeExport(claudeAiDir(process.env), files);
    } catch (e) {
      return fail(`invalid conversations.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  console.log(out);
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
