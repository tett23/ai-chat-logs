#!/usr/bin/env -S bun --no-env-file
// docs/adr/0010: convert claude.ai exports downloaded into the inbox directory, once each.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_FILES, type ExportFile, isStored, storeExport } from "../claude-ai-store.ts";
import { loadEnvFile } from "../env.ts";
import { claudeAiDir, claudeAiInbox } from "../paths.ts";

loadEnvFile();

const errors: string[] = [];
const report = (message: string): void => {
  errors.push(message);
  console.error(`claude-ai-export-scan: ${message}`);
};

// Zip files directly in the inbox, by name; a missing inbox has none.
const zips = (inbox: string): string[] => {
  try {
    return readdirSync(inbox, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".zip"))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    report(`cannot read ${inbox}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
};

// Entry names of a zip, without extracting it.
const entries = (zip: string): string[] => {
  const result = Bun.spawnSync(["unzip", "-Z1", zip]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "not a zip");
  return result.stdout.toString().split("\n").filter((l) => l !== "");
};

// The directory (inside the zip) holding conversations.json at the root or one level down.
const exportPrefix = (names: readonly string[]): string | null => {
  const found = names.find((n) => n === "conversations.json" || /^[^/]+\/conversations\.json$/.test(n));
  return found === undefined ? null : found.slice(0, found.length - "conversations.json".length);
};

// unzip treats member names as patterns; escape the pattern characters.
const literal = (name: string): string => name.replace(/[[\]*?\\]/g, (c) => `\\${c}`);

const read = (zip: string, name: string): Uint8Array => {
  const result = Bun.spawnSync(["unzip", "-p", zip, literal(name)]);
  if (result.exitCode !== 0) throw new Error(`cannot read ${name}: ${result.stderr.toString().trim()}`);
  return result.stdout;
};

const inbox = claudeAiInbox(process.env);
const root = claudeAiDir(process.env);

zips(inbox).forEach((name) => {
  const zip = join(inbox, name);
  try {
    const names = entries(zip);
    const prefix = exportPrefix(names);
    if (prefix === null) return;
    const conversations = read(zip, `${prefix}conversations.json`);
    if (isStored(root, conversations)) return;
    const extras = EXPORT_FILES.filter((f) => f !== "conversations.json" && names.includes(`${prefix}${f}`));
    const files = Object.fromEntries([
      ["conversations.json", conversations],
      ...extras.map((f): [ExportFile, Uint8Array] => [f, read(zip, `${prefix}${f}`)]),
    ]) as Parameters<typeof storeExport>[1];
    console.log(storeExport(root, files));
  } catch (e) {
    report(`${zip}: ${e instanceof Error ? e.message : String(e)}`);
  }
});

process.exitCode = errors.length > 0 ? 1 : 0;
