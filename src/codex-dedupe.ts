// docs/adr/0041 "いまある重複の整理": remove the Codex snapshots whose content the kept store of the
// same original file already holds, with their imported rows, then the payloads nothing points to.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { rebuildCodexPresentation } from "./codex-presentation.ts";
import { DEDUPE_PREFIX, ensureManifestV2, isStoreName, readStore, type Store, withStoreLock } from "./codex-store.ts";
import { payloadReferences, restoredRaw } from "./payloads.ts";
import { rebuildSessions } from "./summaries.ts";

export type DedupeStep = 1 | 2 | 3 | 4 | 5;
export type DedupeOptions = { dryRun: boolean; afterStep?: (step: DedupeStep) => void };
export type Deleted = { directory: string; name: string; sourcePath: string; sources: number; records: number; rawBytes: number; storeBytes: number };
export type Kept = { directory: string; sourcePath: string | null; reason: string };
export type DedupeReport = { deleted: Deleted[]; kept: Kept[]; payloads: number; removed: string[] };

type SourceRow = { id: number; kind: string; path: string; generation: number };
type Group = { sourcePath: string; live: Store[]; pending: Store[] };

const FILES = ["rollout.jsonl", "messages-v1.jsonl"] as const;
const byName = (a: Store, b: Store): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const headSha256 = (path: string, length: number): string | null => {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(16 * 1024 * 1024);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (count === 0) return null;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  } finally { closeSync(fd); }
};

const directoryBytes = (directory: string): number =>
  readdirSync(directory, { withFileTypes: true }).reduce((n, entry) => n + (entry.isFile() ? lstatSync(join(directory, entry.name)).size : 0), 0);

// Stores as they are now: hash-named ones (live) and the ones renamed in step 2 (pending).
const scan = (root: string): { groups: Group[]; kept: Kept[] } => {
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { groups: [], kept: [] }; throw error; }
  const kept: Kept[] = [];
  const groups = new Map<string, Group>();
  for (const entry of names.sort()) {
    const pending = entry.startsWith(DEDUPE_PREFIX);
    const name = pending ? entry.slice(DEDUPE_PREFIX.length) : entry;
    if (!isStoreName(name)) continue;
    const directory = join(root, entry);
    const read = readStore(directory, name);
    if (read === null) { kept.push({ directory, sourcePath: null, reason: "no manifest" }); continue; }
    if ("error" in read) { kept.push({ directory, sourcePath: null, reason: read.error }); continue; }
    const group = groups.get(read.store.sourcePath) ?? { sourcePath: read.store.sourcePath, live: [], pending: [] };
    (pending ? group.pending : group.live).push(read.store);
    groups.set(read.store.sourcePath, group);
  }
  return { groups: [...groups.values()].sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0)), kept };
};

// Paths in sources are those of the store's name, also after the directory was renamed.
const sourcePaths = (root: string, name: string): string[] => FILES.map((file) => join(root, name, file));

type Plan = { keep: Store | null; deletable: (Store & { deleted: Deleted })[]; kept: Kept[] };

const planGroup = (db: Database, root: string, group: Group): Plan => {
  const restore = restoredRaw(db);
  const sourcesOf = db.query<SourceRow, [string]>("SELECT id, kind, path, generation FROM sources WHERE path = ?");
  const rowsOf = db.query<{ line_no: number; raw: string; payload_state: number | null; type: string | null }, [number]>(
    "SELECT line_no, raw, payload_state, type FROM records WHERE source_id = ?");
  const sizeOf = db.query<{ n: number; bytes: number | null }, [number]>("SELECT count(*) n, sum(length(CAST(raw AS BLOB))) bytes FROM records WHERE source_id = ?");
  const others = [...group.live, ...group.pending];
  const keep = [...group.live].sort((a, b) => b.rolloutBytes - a.rolloutBytes || byName(a, b))[0];
  if (keep === undefined) {
    return { keep: null, deletable: [], kept: others.map((s) => ({ directory: s.directory, sourcePath: group.sourcePath, reason: "no store of the original file is left to keep" })) };
  }
  const rest = others.filter((s) => s !== keep).sort(byName);
  const keepNote: Kept = { directory: keep.directory, sourcePath: group.sourcePath, reason: "kept: the largest published rollout" };
  const keepSources = sourcePaths(root, keep.name).map((path) => sourcesOf.all(path));
  const refuse = (reason: string): Plan => ({ keep, deletable: [], kept: [keepNote, ...rest.map((s) => ({ directory: s.directory, sourcePath: group.sourcePath, reason }))] });
  if (rest.length === 0) return { keep, deletable: [], kept: [keepNote] };
  if (keepSources.some((rows) => rows.length === 0)) return refuse("the kept store is not imported");
  if (keepSources.some((rows) => rows.length > 1)) return refuse("a source of the kept store has more than one generation");
  const [keepRollout, keepMessages] = keepSources.map((rows) => rows[0] as SourceRow) as [SourceRow, SourceRow];
  const keepLines = new Map(rowsOf.all(keepRollout.id).map((row) => [row.line_no, restore(row.raw, row.payload_state)]));
  const keepConversation = new Set(rowsOf.all(keepMessages.id).map((row) => restore(row.raw, row.payload_state)));
  const keepHead = (length: number): string | null => headSha256(join(keep.directory, "rollout.jsonl"), length);
  const kept: Kept[] = [keepNote];
  const deletable: Plan["deletable"] = [];
  for (const s of rest) {
    const keepIt = (reason: string) => kept.push({ directory: s.directory, sourcePath: group.sourcePath, reason });
    if (s.rolloutBytes > keep.rolloutBytes || headSha256(join(s.directory, "rollout.jsonl"), s.rolloutBytes) !== keepHead(s.rolloutBytes)) {
      keepIt("the rollout is not a prefix of the kept store's rollout");
      continue;
    }
    const sources = sourcePaths(root, s.name).map((path) => sourcesOf.all(path));
    if (sources.some((rows) => rows.length > 1)) { keepIt("a source has more than one generation"); continue; }
    const [rollout, messages] = sources.map((rows) => rows[0]) as [SourceRow | undefined, SourceRow | undefined];
    if (rollout !== undefined && rowsOf.all(rollout.id).some((row) => keepLines.get(row.line_no) !== restore(row.raw, row.payload_state))) {
      keepIt("a rollout row differs from the kept store's row of the same line");
      continue;
    }
    if (messages !== undefined && rowsOf.all(messages.id).some((row) => row.type !== "custom-title" && !keepConversation.has(restore(row.raw, row.payload_state)))) {
      keepIt("a messages row is not among the kept store's rows");
      continue;
    }
    const ids = [rollout, messages].flatMap((row) => (row === undefined ? [] : [row.id]));
    const sizes = ids.map((id) => sizeOf.get(id) as { n: number; bytes: number | null });
    deletable.push({ ...s, deleted: {
      directory: s.directory, name: s.name, sourcePath: group.sourcePath, sources: ids.length,
      records: sizes.reduce((n, x) => n + x.n, 0), rawBytes: sizes.reduce((n, x) => n + (x.bytes ?? 0), 0), storeBytes: directoryBytes(s.directory),
    } });
  }
  return { keep, deletable, kept };
};

// Step 3: the rows of the deleted stores' sources, then the summaries and presentation of their sessions.
const deleteRows = (db: Database, root: string, names: readonly string[]): void => {
  const sources = db.query<{ id: number }, [string]>("SELECT id FROM sources WHERE path = ?");
  const ids = names.flatMap((name) => sourcePaths(root, name).flatMap((path) => sources.all(path).map((row) => row.id)));
  if (ids.length === 0) return;
  const restore = restoredRaw(db);
  const sessions = new Set<string>();
  db.transaction(() => {
    for (const id of ids) {
      db.query<{ session_id: string }, [number]>("SELECT DISTINCT session_id FROM records WHERE source_id = ? AND session_id IS NOT NULL")
        .all(id).forEach((row) => sessions.add(row.session_id));
      const first = db.query<{ raw: string; payload_state: number | null }, [number]>(
        "SELECT r.raw, r.payload_state FROM records r JOIN sources s ON s.id = r.source_id WHERE r.source_id = ? AND r.line_no = 1 AND s.kind = 'codex/rollout'").get(id);
      if (first) {
        try {
          const value = JSON.parse(restore(first.raw, first.payload_state)) as { type?: unknown; payload?: { id?: unknown } };
          if (value?.type === "session_meta" && typeof value.payload?.id === "string") sessions.add(value.payload.id);
        } catch { /* not a session */ }
      }
      db.query("DELETE FROM record_texts WHERE rowid IN (SELECT rowid FROM records WHERE source_id = ?)").run(id);
      db.query("DELETE FROM record_tool_texts WHERE rowid IN (SELECT rowid FROM records WHERE source_id = ?)").run(id);
      db.query("DELETE FROM records WHERE source_id = ?").run(id);
      db.query("DELETE FROM sources WHERE id = ?").run(id);
    }
    const keys = [...sessions].sort();
    rebuildSessions(db, keys.map((sessionId) => ({ provider: "codex", sessionId })));
    for (const sessionId of keys) {
      db.query("DELETE FROM codex_item_presentation WHERE session_id = ?").run(sessionId);
      db.query("DELETE FROM codex_session_presentation WHERE session_id = ?").run(sessionId);
    }
    const errors = rebuildCodexPresentation(db, sessions);
    if (errors.length > 0) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  }).immediate();
};

// Step 4 and its dry run: the payloads no records.raw with payload_state 1 points to.
const orphanPayloads = (db: Database): string[] => {
  const referenced = new Set<string>();
  for (const row of db.query<{ raw: string }, []>("SELECT raw FROM records WHERE payload_state = 1").iterate()) {
    for (const sha256 of payloadReferences(row.raw)) referenced.add(sha256);
  }
  return db.query<{ sha256: string }, []>("SELECT sha256 FROM payloads").all().map((row) => row.sha256).filter((sha256) => !referenced.has(sha256));
};

export const dedupeCodexStore = (db: Database, store: string, options: DedupeOptions): DedupeReport => {
  const root = resolve(store);
  const after = options.afterStep ?? (() => {});
  const report: DedupeReport = { deleted: [], kept: [], payloads: 0, removed: [] };
  const first = scan(root);
  report.kept.push(...first.kept);
  for (const { sourcePath } of first.groups) {
    // The plan and the steps 1 and 2 are made with the lock held; a pre-compaction save may run meanwhile.
    const run = (): Plan => {
      const group = scan(root).groups.find((g) => g.sourcePath === sourcePath);
      if (group === undefined) return { keep: null, deletable: [], kept: [] };
      const plan = planGroup(db, root, group);
      if (options.dryRun || plan.keep === null || plan.deletable.length === 0) return plan;
      ensureManifestV2(plan.keep);
      after(1);
      for (const s of plan.deletable) {
        if (s.directory === join(root, s.name)) {
          renameSync(s.directory, join(root, `${DEDUPE_PREFIX}${s.name}`));
          after(2);
        }
      }
      return plan;
    };
    const plan = options.dryRun ? run() : withStoreLock(root, run);
    report.kept.push(...plan.kept);
    report.deleted.push(...plan.deletable.map((s) => s.deleted));
    if (!options.dryRun && plan.deletable.length > 0) {
      deleteRows(db, root, plan.deletable.map((s) => s.name));
      after(3);
    }
  }
  if (options.dryRun) {
    report.payloads = orphanPayloads(db).length;
    return report;
  }
  report.payloads = db.transaction(() => {
    const orphans = orphanPayloads(db);
    const remove = db.query("DELETE FROM payloads WHERE sha256 = ?");
    orphans.forEach((sha256) => remove.run(sha256));
    return orphans.length;
  }).immediate();
  after(4);
  withStoreLock(root, () => {
    const exists = db.query<{ n: number }, [string]>("SELECT count(*) n FROM sources WHERE path = ?");
    for (const entry of readdirSync(root).filter((name) => name.startsWith(DEDUPE_PREFIX)).sort()) {
      const name = entry.slice(DEDUPE_PREFIX.length);
      if (!isStoreName(name) || sourcePaths(root, name).some((path) => (exists.get(path)?.n ?? 0) > 0)) continue;
      rmSync(join(root, entry), { recursive: true, force: true });
      report.removed.push(join(root, entry));
      after(5);
    }
  });
  return report;
};

