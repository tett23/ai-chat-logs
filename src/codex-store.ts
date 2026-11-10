// docs/adr/0034: immutable snapshots of complete Codex JSONL lines.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertCodexLines } from "./codex.ts";

type CodexSource = { kind: "codex/conversation" | "codex/rollout"; path: string };
export type ConversionRun = { status: 0 | 1; published: number; directories: string[]; errors: string[] };
type Manifest = { converterVersion: 1; sha256: string; sourcePath: string; sessions: number; messageLines: number; warnings: number; status: 0 | 1 };
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const notFound = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const isHash = (name: string): boolean => /^[a-f0-9]{64}$/.test(name);

const walk = (directory: string): string[] => {
  try {
    const root = lstatSync(directory);
    if (root.isSymbolicLink()) return [];
    if (!root.isDirectory()) throw new Error(`not a directory: ${directory}`);
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    });
  } catch (error) {
    if (notFound(error)) return [];
    throw error;
  }
};

const snapshot = (path: string): Buffer => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("source is not a regular file");
    const all = readFileSync(fd);
    const end = all.lastIndexOf(10) + 1;
    const fixed = all.subarray(0, end);
    const after = fstatSync(fd);
    if (after.size < fixed.length) throw new Error("source changed while reading");
    // A second read of the captured range detects edits even when metadata was restored.
    const check = Buffer.alloc(fixed.length);
    let offset = 0;
    while (offset < check.length) {
      const count = readSync(fd, check, offset, check.length - offset, offset);
      if (count === 0) throw new Error("source truncated while reading");
      offset += count;
    }
    if (sha256(check) !== sha256(fixed)) throw new Error("source changed while reading");
    return fixed;
  } finally { closeSync(fd); }
};

const manifestAt = (directory: string): Manifest | null => {
  try {
    const manifestPath = join(directory, "manifest-v1.json");
    if (!lstatSync(manifestPath).isFile() || !lstatSync(join(directory, "rollout.jsonl")).isFile()
      || !lstatSync(join(directory, "messages-v1.jsonl")).isFile()) return null;
    const value = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    return value.converterVersion === 1 && (value.status === 0 || value.status === 1)
      && value.sha256 === directory.split("/").at(-1) ? value : null;
  } catch { return null; }
};

const save = (path: string, store: string): { directory: string; published: boolean; manifest: Manifest; warnings: string[] } => {
  const bytes = snapshot(path);
  const hash = sha256(bytes), directory = join(store, hash);
  const existing = manifestAt(directory);
  if (existing) return { directory, published: false, manifest: existing, warnings: [] };
  if (existsSync(directory)) throw new Error(`incomplete snapshot exists: ${directory}`);
  const lines = bytes.length ? new TextDecoder().decode(bytes).split("\n").slice(0, -1) : [];
  const converted = convertCodexLines(lines);
  const manifest: Manifest = { converterVersion: 1, sha256: hash, sourcePath: path,
    sessions: converted.messageCount > 0 ? 1 : 0, messageLines: converted.messageCount,
    warnings: converted.warnings.length, status: converted.status };
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(store, ".partial-"));
  chmodSync(staging, 0o700);
  try {
    for (const [name, content] of [["rollout.jsonl", bytes], ["messages-v1.jsonl", converted.messages], ["manifest-v1.json", `${JSON.stringify(manifest)}\n`]] as const) {
      const out = join(staging, name);
      writeFileSync(out, content, { mode: 0o600, flag: "wx" });
      chmodSync(out, 0o600);
    }
    try { renameSync(staging, directory); }
    catch (error) {
      const winner = manifestAt(directory);
      if (winner) return { directory, published: false, manifest: winner, warnings: [] };
      throw error;
    }
    return { directory, published: true, manifest, warnings: converted.warnings };
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
};

export const convertCodexLogs = (codexRoot: string, store: string): ConversionRun => {
  const result: ConversionRun = { status: 0, published: 0, directories: [], errors: [] };
  let paths: string[];
  try { paths = [...walk(join(codexRoot, "sessions")), ...walk(join(codexRoot, "archived_sessions"))].sort(); }
  catch (error) { return { ...result, status: 1, errors: [String(error)] }; }
  for (const path of paths) {
    try {
      const saved = save(resolve(path), resolve(store));
      result.directories.push(saved.directory);
      if (saved.published) result.published++;
      if (saved.manifest.status === 1) result.status = 1;
      result.errors.push(...saved.warnings.map((warning) => `${path}: ${warning}`));
    } catch (error) {
      result.status = 1;
      result.errors.push(`${path}: ${String(error)}`);
    }
  }
  return result;
};

export const listCodexSources = (store: string): CodexSource[] => {
  let entries;
  try { entries = readdirSync(store, { withFileTypes: true }); }
  catch (error) { if (notFound(error)) return []; throw error; }
  return entries.filter((entry) => entry.isDirectory() && isHash(entry.name))
    .flatMap((entry): CodexSource[] => {
      const directory = join(resolve(store), entry.name);
      return manifestAt(directory) ? [
        { kind: "codex/conversation", path: join(directory, "messages-v1.jsonl") },
        { kind: "codex/rollout", path: join(directory, "rollout.jsonl") },
      ] : [];
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
};
