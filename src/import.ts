import type { Database } from "bun:sqlite";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { detectChange } from "./change.ts";
import { isFileKind, isLineKind } from "./kinds.ts";
import { splitCompleteLines } from "./lines.ts";

export type SourceEntry = { kind: string; path: string };
export type ImportError = { path: string; message: string };
export type RunSummary = {
  runId: number;
  sourcesSeen: number;
  recordsAdded: number;
  blobsAdded: number;
  errors: ImportError[];
};
export type ImportOptions = { markMissing?: boolean; now?: () => string; chunkBytes?: number };

type SourceRow = {
  id: number;
  generation: number;
  consumed_bytes: number;
  consumed_lines: number;
  head_sha256: string | null;
};

const HEAD_BYTES = 4096;
const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024;

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const readRange = (path: string, start: number, end: number): Uint8Array => {
  const buffer = new Uint8Array(Math.max(0, end - start));
  const fd = openSync(path, "r");
  try {
    const fill = (offset: number): number => {
      if (offset >= buffer.length) return offset;
      const n = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      return n === 0 ? offset : fill(offset + n);
    };
    return buffer.subarray(0, fill(0));
  } finally {
    closeSync(fd);
  }
};

const headHash = (path: string, consumed: number): string | null =>
  consumed === 0 ? null : sha256(readRange(path, 0, Math.min(HEAD_BYTES, consumed)));

const latestSource = (db: Database, path: string): SourceRow | null =>
  db
    .query<SourceRow, [string]>(
      "SELECT id, generation, consumed_bytes, consumed_lines, head_sha256 FROM sources WHERE path = ? ORDER BY generation DESC LIMIT 1",
    )
    .get(path);

const insertSource = (db: Database, kind: string, path: string, generation: number, now: string): SourceRow =>
  db
    .query<SourceRow, [string, string, number, string, string]>(
      `INSERT INTO sources (kind, path, generation, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
       RETURNING id, generation, consumed_bytes, consumed_lines, head_sha256`,
    )
    .get(kind, path, generation, now, now) as SourceRow;

const markSeen = (db: Database, path: string, now: string): void => {
  db.query("UPDATE sources SET missing_since = NULL WHERE path = ?").run(path);
  db.query("UPDATE sources SET last_seen_at = ? WHERE path = ?").run(now, path);
};

type Chunk = { lines: string[]; consumed: number };

// Read [start, size) in chunks so that a file larger than the maximum string length can be imported.
// A chunk without a newline is widened until it holds a complete line or reaches the end of the file.
function* readChunks(path: string, start: number, size: number, chunkBytes: number): Generator<Chunk> {
  let pos = start;
  let width = chunkBytes;
  while (pos < size) {
    const end = Math.min(size, pos + width);
    const chunk = splitCompleteLines(readRange(path, pos, end));
    if (chunk.consumed > 0) {
      yield chunk;
      pos += chunk.consumed;
      width = chunkBytes;
    } else if (end === size) {
      return;
    } else {
      width *= 2;
    }
  }
}

// docs/adr/0001: import complete lines appended since the last run; a rewritten file starts a new generation.
const importLines = (db: Database, kind: string, path: string, now: string, chunkBytes: number): number =>
  db
    .transaction(() => {
      const { size, mtimeMs } = statSync(path);
      const stored = latestSource(db, path) ?? insertSource(db, kind, path, 0, now);
      const change = detectChange({
        size,
        consumedBytes: stored.consumed_bytes,
        storedHead: stored.head_sha256,
        currentHead: headHash(path, stored.consumed_bytes),
      });
      markSeen(db, path, now);
      if (change === "unchanged") return 0;
      const source = change === "rewritten" ? insertSource(db, kind, path, stored.generation + 1, now) : stored;
      const insert = db.query("INSERT INTO records (source_id, line_no, raw, imported_at) VALUES (?, ?, ?, ?)");
      const totals = readChunks(path, source.consumed_bytes, size, chunkBytes).reduce(
        (acc, { lines, consumed }) => {
          const rows = lines.map((raw, i) => ({ raw, lineNo: acc.lines + i + 1 })).filter(({ raw }) => raw !== "");
          rows.forEach(({ raw, lineNo }) => insert.run(source.id, lineNo, raw, now));
          return { bytes: acc.bytes + consumed, lines: acc.lines + lines.length, added: acc.added + rows.length };
        },
        { bytes: source.consumed_bytes, lines: source.consumed_lines, added: 0 },
      );
      db.query(
        `UPDATE sources SET consumed_bytes = ?, consumed_lines = ?, head_sha256 = ?, size = ?, mtime_ms = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(totals.bytes, totals.lines, headHash(path, totals.bytes), size, Math.trunc(mtimeMs), now, source.id);
      return totals.added;
    })
    .immediate();

// docs/adr/0001: store the whole file content-addressed; a new version only when the content is new for the path.
const importFile = (db: Database, kind: string, path: string, now: string): number =>
  db
    .transaction(() => {
      const { size, mtimeMs } = statSync(path);
      const content = readFileSync(path);
      const hash = sha256(content);
      const source = latestSource(db, path) ?? insertSource(db, kind, path, 0, now);
      const added = db.query("INSERT OR IGNORE INTO blobs (sha256, size, content) VALUES (?, ?, ?)").run(hash, content.length, content).changes;
      db.query("INSERT OR IGNORE INTO file_versions (source_id, sha256, first_seen_at) VALUES (?, ?, ?)").run(source.id, hash, now);
      db.query("UPDATE sources SET size = ?, mtime_ms = ? WHERE id = ?").run(size, Math.trunc(mtimeMs), source.id);
      markSeen(db, path, now);
      return added;
    })
    .immediate();

const markMissing = (db: Database, listed: ReadonlySet<string>, now: string): void => {
  const paths = db.query<{ path: string }, []>("SELECT DISTINCT path FROM sources WHERE missing_since IS NULL").all();
  const update = db.query("UPDATE sources SET missing_since = ? WHERE path = ? AND missing_since IS NULL");
  db.transaction(() => paths.filter(({ path }) => !listed.has(path)).forEach(({ path }) => update.run(now, path))).immediate();
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Outcome = { records: number; blobs: number } | { error: ImportError };

const importOne = (db: Database, { kind, path }: SourceEntry, now: string, chunkBytes: number): Outcome => {
  try {
    if (isLineKind(kind)) return { records: importLines(db, kind, path, now, chunkBytes), blobs: 0 };
    if (isFileKind(kind)) return { records: 0, blobs: importFile(db, kind, path, now) };
    return { error: { path, message: `unknown kind: ${kind}` } };
  } catch (e) {
    return { error: { path, message: errorMessage(e) } };
  }
};

export const importSources = (db: Database, entries: readonly SourceEntry[], options: ImportOptions): RunSummary => {
  const now = options.now ?? (() => new Date().toISOString());
  const runId = db.query<{ id: number }, [string]>("INSERT INTO runs (started_at) VALUES (?) RETURNING id").get(now())?.id as number;
  const outcomes = entries.map((entry) => importOne(db, entry, now(), options.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  if (options.markMissing) markMissing(db, new Set(entries.map((e) => e.path)), now());
  const errors = outcomes.flatMap((o) => ("error" in o ? [o.error] : []));
  const summary: RunSummary = {
    runId,
    sourcesSeen: entries.length,
    recordsAdded: outcomes.reduce((n, o) => n + ("records" in o ? o.records : 0), 0),
    blobsAdded: outcomes.reduce((n, o) => n + ("blobs" in o ? o.blobs : 0), 0),
    errors,
  };
  db.query(
    "UPDATE runs SET finished_at = ?, sources_seen = ?, records_added = ?, blobs_added = ?, errors = ? WHERE id = ?",
  ).run(now(), summary.sourcesSeen, summary.recordsAdded, summary.blobsAdded, errors.length ? JSON.stringify(errors) : null, runId);
  return summary;
};

// "<kind>\t<path>" per line; blank lines are ignored.
export const parseSourceList = (text: string): SourceEntry[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab < 0 ? { kind: line, path: "" } : { kind: line.slice(0, tab), path: line.slice(tab + 1) };
    });
