// docs/adr/0034, docs/adr/0041: stores of complete Codex JSONL lines. A store is created once and the
// lines a source grows by are appended to it; only the range its manifest names is published.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { convertCodexLines } from "./codex.ts";

type CodexSource = { kind: "codex/conversation" | "codex/rollout"; path: string };
export type ConversionRun = { status: 0 | 1; published: number; directories: string[]; errors: string[] };

// docs/adr/0034: manifest-v1.json; the whole files are published.
type ManifestV1 = { converterVersion: 1; sha256: string; sourcePath: string; sessions: number; messageLines: number; warnings: number; status: 0 | 1 };
// docs/adr/0041: manifest-v2.json; the files are published up to rolloutBytes and messagesBytes.
export type ManifestV2 = {
  converterVersion: 1;
  sourcePath: string;
  firstLineSha256: string | null;
  rolloutBytes: number;
  rolloutLines: number;
  rolloutSha256: string;
  messagesBytes: number;
  messageLines: number;
  lastSourceOrder: number;
  title: string | null;
  sessions: number;
  warnings: number;
  status: 0 | 1;
};
// A store as read: its manifest-v2.json, or the values a manifest-v2.json would hold for a store with
// manifest-v1.json alone (computed only when needed, see `upgrade`).
export type Store = {
  name: string;
  directory: string;
  version: 1 | 2;
  sourcePath: string;
  firstLineSha256: string | null;
  rolloutBytes: number;
  status: 0 | 1;
};
export type StoreRead = { store: Store } | { error: string } | null;

export const MANIFEST_V1 = "manifest-v1.json";
export const MANIFEST_V2 = "manifest-v2.json";
export const LOCK_FILE = ".lock.sqlite";
export const LOCK_TIMEOUT_MS = 5000;
export const DEDUPE_PREFIX = ".dedupe-";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const notFound = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
export const isStoreName = (name: string): boolean => /^[a-f0-9]{64}$/.test(name);
const isFile = (path: string): boolean => { try { return lstatSync(path).isFile(); } catch { return false; } };

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

export const readCodexSnapshot = (path: string, afterFirstRead: () => void = () => {}): Buffer => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("source is not a regular file");
    const all = readFileSync(fd);
    const end = all.lastIndexOf(10) + 1;
    const fixed = all.subarray(0, end);
    afterFirstRead();
    const after = fstatSync(fd);
    if (after.size < before.size || after.size < fixed.length
      || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) throw new Error("source changed while reading");
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

const readRange = (path: string, start: number, end: number): Buffer => {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (count === 0) break;
      offset += count;
    }
    return buffer.subarray(0, offset);
  } finally { closeSync(fd); }
};

// SHA-256 of the bytes [0, length) of a file, read in chunks.
const headSha256 = (path: string, length: number): string => {
  const hash = createHash("sha256");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(Math.min(Math.max(length, 1), 16 * 1024 * 1024));
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (count === 0) throw new Error(`file is shorter than ${length} bytes: ${path}`);
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  } finally { closeSync(fd); }
};

// SHA-256 of the first line (with its newline) of a file, or null when it has no complete line.
const firstLineSha256 = (path: string, limit: number): string | null => {
  const hash = createHash("sha256");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < limit) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit - offset), offset);
      if (count === 0) return null;
      const newline = buffer.subarray(0, count).indexOf(10);
      if (newline >= 0) return hash.update(buffer.subarray(0, newline + 1)).digest("hex");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return null;
  } finally { closeSync(fd); }
};

const fileSize = (path: string): number => lstatSync(path).size;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isHex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export const validManifestV2 = (value: unknown): value is ManifestV2 => {
  const m = value as Partial<ManifestV2> | null;
  return typeof m === "object" && m !== null && m.converterVersion === 1 && typeof m.sourcePath === "string"
    && (m.firstLineSha256 === null || isHex(m.firstLineSha256)) && isCount(m.rolloutBytes) && isCount(m.rolloutLines)
    && isHex(m.rolloutSha256) && isCount(m.messagesBytes) && isCount(m.messageLines) && isCount(m.lastSourceOrder)
    && (m.title === null || typeof m.title === "string") && isCount(m.sessions) && isCount(m.warnings) && (m.status === 0 || m.status === 1);
};

const readManifestV2 = (directory: string): ManifestV2 => {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(directory, MANIFEST_V2), "utf8")); }
  catch { throw new Error(`${MANIFEST_V2} is not readable JSON: ${directory}`); }
  if (!validManifestV2(value)) throw new Error(`${MANIFEST_V2} lacks a required key: ${directory}`);
  if (!isFile(join(directory, "rollout.jsonl")) || !isFile(join(directory, "messages-v1.jsonl"))) throw new Error(`store files are missing: ${directory}`);
  if (value.rolloutBytes > fileSize(join(directory, "rollout.jsonl")) || value.messagesBytes > fileSize(join(directory, "messages-v1.jsonl"))) {
    throw new Error(`${MANIFEST_V2} names more bytes than the files hold: ${directory}`);
  }
  return value;
};

const readManifestV1 = (directory: string, name: string): ManifestV1 | null => {
  try {
    const manifestPath = join(directory, MANIFEST_V1);
    if (!isFile(manifestPath) || !isFile(join(directory, "rollout.jsonl")) || !isFile(join(directory, "messages-v1.jsonl"))) return null;
    const value = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestV1;
    return value.converterVersion === 1 && (value.status === 0 || value.status === 1) && typeof value.sourcePath === "string"
      && value.sha256 === name ? value : null;
  } catch { return null; }
};

// Read a store. `name` is the store's name (the directory may have been renamed to .dedupe-<name>).
// null: neither manifest exists; error: manifest-v2.json is broken or manifest-v1.json is not valid.
export const readStore = (directory: string, name: string = directory.split("/").at(-1) as string): StoreRead => {
  try {
    if (existsSync(join(directory, MANIFEST_V2))) {
      const m = readManifestV2(directory);
      return { store: { name, directory, version: 2, sourcePath: m.sourcePath, firstLineSha256: m.firstLineSha256, rolloutBytes: m.rolloutBytes, status: m.status } };
    }
    if (!existsSync(join(directory, MANIFEST_V1))) return null;
    const v1 = readManifestV1(directory, name);
    if (v1 === null) return { error: `${MANIFEST_V1} is not valid: ${directory}` };
    const rolloutBytes = fileSize(join(directory, "rollout.jsonl"));
    return { store: { name, directory, version: 1, sourcePath: v1.sourcePath, firstLineSha256: firstLineSha256(join(directory, "rollout.jsonl"), rolloutBytes), rolloutBytes, status: v1.status } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

// The published range of a file of a store, given its size taken before: docs/adr/0041 "取り込み".
export const publishedSize = (path: string, size: number): number => {
  const directory = dirname(path), file = path.slice(directory.length + 1);
  if (file !== "rollout.jsonl" && file !== "messages-v1.jsonl") return size;
  if (!existsSync(join(directory, MANIFEST_V2))) return size;
  const m = readManifestV2(directory);
  return Math.min(size, file === "rollout.jsonl" ? m.rolloutBytes : m.messagesBytes);
};

// --- the lock: docs/adr/0041 "ロック" ---

// The lock is held while the transaction is open; the OS releases it when the process ends. When it
// is not taken in `timeoutMs`, `fn` is not run and an error is thrown.
export const withStoreLock = <T>(store: string, fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T => {
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const path = join(store, LOCK_FILE);
  const db = new Database(path, { create: true });
  try {
    chmodSync(path, 0o600);
    db.run(`PRAGMA busy_timeout = ${Math.trunc(timeoutMs)}`);
    try { db.run("BEGIN EXCLUSIVE"); }
    catch (error) { throw new Error(`the store is locked by another process: ${String(error)}`); }
    try { return fn(); }
    finally { db.run("COMMIT"); }
  } finally { db.close(); }
};

// --- writing ---

const writeAllAt = (fd: number, bytes: Uint8Array, position: number): void => {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, position + offset);
};

const writeManifest = (directory: string, manifest: ManifestV2): void => {
  const tmp = join(directory, `.${MANIFEST_V2}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try { writeAllAt(fd, Buffer.from(`${JSON.stringify(manifest)}\n`), 0); fsyncSync(fd); }
  finally { closeSync(fd); }
  chmodSync(tmp, 0o600);
  renameSync(tmp, join(directory, MANIFEST_V2));
};

type Parsed = { rows: Record<string, unknown>[]; titles: string[] };
const parseMessages = (text: string): Parsed => {
  const all = text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    rows: all.filter((row) => row.type !== "custom-title"),
    titles: all.filter((row) => row.type === "custom-title").map((row) => String(row.customTitle)),
  };
};
const countLines = (bytes: Uint8Array): number => bytes.reduce((n, byte) => n + (byte === 10 ? 1 : 0), 0);
const lineOf = (warning: string): number => Number(/^line (\d+):/.exec(warning)?.[1] ?? 0);

// The manifest-v2.json of a store with manifest-v1.json alone, publishing its whole files.
const upgradedManifest = (store: Store): ManifestV2 => {
  const v1 = readManifestV1(store.directory, store.name) as ManifestV1;
  const rollout = readFileSync(join(store.directory, "rollout.jsonl"));
  const messages = readFileSync(join(store.directory, "messages-v1.jsonl"));
  const parsed = parseMessages(messages.toString("utf8"));
  return {
    converterVersion: 1, sourcePath: v1.sourcePath, firstLineSha256: store.firstLineSha256,
    rolloutBytes: rollout.length, rolloutLines: countLines(rollout), rolloutSha256: sha256(rollout),
    messagesBytes: messages.length, messageLines: v1.messageLines,
    lastSourceOrder: Math.max(0, ...parsed.rows.map((row) => typeof row.sourceOrder === "number" ? row.sourceOrder : 0)),
    title: parsed.titles.at(-1) ?? null, sessions: v1.sessions, warnings: v1.warnings, status: v1.status,
  };
};

// docs/adr/0041 "残す保存先に manifest-v2.json が無ければ作る": called with the lock held.
export const ensureManifestV2 = (store: Store): ManifestV2 => {
  if (store.version === 2) return readManifestV2(store.directory);
  const manifest = upgradedManifest(store);
  writeManifest(store.directory, manifest);
  return manifest;
};

type Saved = { directory: string; published: boolean; manifest: { status: 0 | 1 }; warnings: string[] };

// docs/adr/0041 "追記の手順", with the lock held.
const appendTo = (store: Store, input: Buffer, afterWrite: (name: string) => void): Saved => {
  const before = ensureManifestV2(store);
  const rolloutPath = join(store.directory, "rollout.jsonl"), messagesPath = join(store.directory, "messages-v1.jsonl");
  const lines = new TextDecoder().decode(input).split("\n").slice(0, -1);
  const converted = convertCodexLines(lines);
  const parsed = parseMessages(converted.messages);
  const added = parsed.rows.filter((row) => typeof row.sourceOrder === "number" && row.sourceOrder > before.lastSourceOrder);
  const title = parsed.titles.at(-1) ?? null;
  const titleLine = title !== null && title !== before.title ? [{ type: "custom-title", sessionId: converted.sessionId, customTitle: title }] : [];
  const tail = Buffer.from([...added, ...titleLine].map((row) => `${JSON.stringify(row)}\n`).join(""));
  const rollout = openSync(rolloutPath, constants.O_WRONLY | constants.O_NOFOLLOW);
  const messages = openSync(messagesPath, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    ftruncateSync(rollout, before.rolloutBytes);
    ftruncateSync(messages, before.messagesBytes);
    writeAllAt(rollout, input.subarray(before.rolloutBytes), before.rolloutBytes);
    afterWrite("rollout.jsonl");
    writeAllAt(messages, tail, before.messagesBytes);
    afterWrite("messages-v1.jsonl");
    fsyncSync(rollout);
    fsyncSync(messages);
  } finally {
    closeSync(rollout);
    closeSync(messages);
  }
  const messageLines = before.messageLines + added.length;
  const manifest: ManifestV2 = {
    ...before,
    rolloutBytes: input.length, rolloutLines: lines.length, rolloutSha256: sha256(input),
    messagesBytes: before.messagesBytes + tail.length, messageLines,
    lastSourceOrder: Math.max(before.lastSourceOrder, ...added.map((row) => row.sourceOrder as number)),
    title: title ?? before.title, sessions: messageLines > 0 ? 1 : 0,
    warnings: converted.warnings.filter((w) => lineOf(w) > before.rolloutLines).length, status: converted.status,
  };
  writeManifest(store.directory, manifest);
  afterWrite(MANIFEST_V2);
  return { directory: store.directory, published: true, manifest, warnings: converted.warnings.filter((w) => lineOf(w) > before.rolloutLines) };
};

// docs/adr/0034 "新しい保存先", with manifest-v2.json: staged, then published by rename.
const createStore = (path: string, store: string, input: Buffer, afterWrite: (name: string) => void): Saved => {
  const name = sha256(input), directory = join(store, name);
  if (existsSync(directory)) throw new Error(`a store of the same name exists but is not readable: ${directory}`);
  const lines = input.length ? new TextDecoder().decode(input).split("\n").slice(0, -1) : [];
  const converted = convertCodexLines(lines);
  const parsed = parseMessages(converted.messages);
  const messages = Buffer.from(converted.messages);
  const manifest: ManifestV2 = {
    converterVersion: 1, sourcePath: path, firstLineSha256: lines.length ? sha256(Buffer.from(`${lines[0]}\n`)) : null,
    rolloutBytes: input.length, rolloutLines: lines.length, rolloutSha256: sha256(input),
    messagesBytes: messages.length, messageLines: converted.messageCount,
    lastSourceOrder: Math.max(0, ...parsed.rows.map((row) => row.sourceOrder as number)),
    title: parsed.titles.at(-1) ?? null, sessions: converted.messageCount > 0 ? 1 : 0,
    warnings: converted.warnings.length, status: converted.status,
  };
  const staging = mkdtempSync(join(store, ".partial-"));
  chmodSync(staging, 0o700);
  try {
    for (const [file, content] of [["rollout.jsonl", input], ["messages-v1.jsonl", messages], [MANIFEST_V2, `${JSON.stringify(manifest)}\n`]] as const) {
      const out = join(staging, file);
      writeFileSync(out, content, { mode: 0o600, flag: "wx" });
      chmodSync(out, 0o600);
      afterWrite(file);
    }
    renameSync(staging, directory);
    return { directory, published: true, manifest, warnings: converted.warnings };
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
};

// The first-line hashes of stores never change, so a run reads each store's manifest once to find
// the candidates and reads the candidates' manifests again under the lock.
export type StoreCache = { firstLines: Map<string, string | null>; errors: Map<string, string> };
export const newStoreCache = (): StoreCache => ({ firstLines: new Map(), errors: new Map() });

const candidates = (store: string, firstLine: string, cache: StoreCache): Store[] => {
  let names: string[];
  try { names = readdirSync(store).filter(isStoreName); }
  catch (error) { if (notFound(error)) return []; throw error; }
  return names.flatMap((name): Store[] => {
    const known = cache.firstLines.get(name);
    if (known !== undefined && known !== firstLine) return [];
    const read = readStore(join(store, name), name);
    if (read === null) { cache.errors.set(name, `no manifest: ${join(store, name)}`); return []; }
    if ("error" in read) { cache.errors.set(name, read.error); return []; }
    cache.errors.delete(name);
    cache.firstLines.set(name, read.store.firstLineSha256);
    return read.store.firstLineSha256 === firstLine ? [read.store] : [];
  }).sort((a, b) => b.rolloutBytes - a.rolloutBytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

// docs/adr/0041 "保存先の決め方".
export const saveCodexSnapshot = (path: string, store: string, afterWrite: (name: string) => void = () => {}, cache: StoreCache = newStoreCache()): Saved => {
  const input = readCodexSnapshot(path);
  return withStoreLock(store, () => {
    if (input.length === 0) {
      const directory = join(store, sha256(input));
      const read = readStore(directory);
      if (read !== null && "store" in read) return { directory, published: false, manifest: { status: read.store.status }, warnings: [] };
      return createStore(path, store, input, afterWrite);
    }
    const newline = input.indexOf(10);
    const found = candidates(store, sha256(input.subarray(0, newline + 1)), cache);
    const inputHash = (length: number): string => sha256(input.subarray(0, length));
    const same = found.find((c) => c.rolloutBytes >= input.length && headSha256(join(c.directory, "rollout.jsonl"), input.length) === inputHash(input.length));
    if (same) return { directory: same.directory, published: false, manifest: { status: same.status }, warnings: [] };
    const target = found.find((c) => c.rolloutBytes < input.length && headSha256(join(c.directory, "rollout.jsonl"), c.rolloutBytes) === inputHash(c.rolloutBytes));
    if (target) return appendTo(target, input, afterWrite);
    return createStore(path, store, input, afterWrite);
  });
};

export const convertCodexLogs = (codexRoot: string, store: string, afterWrite: (name: string) => void = () => {}): ConversionRun => {
  const result: ConversionRun = { status: 0, published: 0, directories: [], errors: [] };
  let paths: string[];
  try { paths = [...walk(join(codexRoot, "sessions")), ...walk(join(codexRoot, "archived_sessions"))].sort(); }
  catch (error) { return { ...result, status: 1, errors: [String(error)] }; }
  const cache = newStoreCache();
  for (const path of paths) {
    try {
      const saved = saveCodexSnapshot(resolve(path), resolve(store), afterWrite, cache);
      result.directories.push(saved.directory);
      if (saved.published) result.published++;
      if (saved.manifest.status === 1) result.status = 1;
      result.errors.push(...saved.warnings.map((warning) => `${path}: ${warning}`));
    } catch (error) {
      result.status = 1;
      result.errors.push(`${path}: ${String(error)}`);
    }
  }
  if (cache.errors.size > 0) {
    result.status = 1;
    result.errors.push(...cache.errors.values());
  }
  return result;
};

export const codexSnapshotSources = (directory: string): CodexSource[] => [
  { kind: "codex/conversation", path: join(directory, "messages-v1.jsonl") },
  { kind: "codex/rollout", path: join(directory, "rollout.jsonl") },
];

// docs/adr/0041: the stores with a valid manifest-v1.json or manifest-v2.json and a store name.
export const scanCodexSources = (store: string): { sources: CodexSource[]; errors: string[] } => {
  let entries;
  try { entries = readdirSync(store, { withFileTypes: true }); }
  catch (error) { if (notFound(error)) return { sources: [], errors: [] }; throw error; }
  const errors: string[] = [];
  const sources = entries.filter((entry) => entry.isDirectory() && isStoreName(entry.name))
    .flatMap((entry): CodexSource[] => {
      const directory = join(resolve(store), entry.name);
      const read = readStore(directory, entry.name);
      if (read === null) return [];
      if ("error" in read) { errors.push(read.error); return []; }
      return codexSnapshotSources(directory);
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
  return { sources, errors };
};

export const listCodexSources = (store: string): CodexSource[] => scanCodexSources(store).sources;
