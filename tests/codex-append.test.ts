// docs/adr/0041: append grown Codex logs to one store, and remove the existing duplicate snapshots.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertCodexLines } from "../src/codex.ts";
import { dedupeCodexStore } from "../src/codex-dedupe.ts";
import { convertCodexLogs, listCodexSources, saveCodexSnapshot } from "../src/codex-store.ts";
import { openDatabase } from "../src/db.ts";
import { importSources } from "../src/import.ts";
import { restoredRaw } from "../src/payloads.ts";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

type Row = Record<string, unknown>;
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const meta = (id = "s1") => ({ type: "session_meta", payload: { id, cwd: "/repo", source: "cli" } });
const say = (id: string, text: string, role = "assistant") => ({
  type: "response_item", timestamp: "2026-11-17T00:00:00Z",
  payload: { type: "message", id, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});
const big = (id: string, fill: string) => ({
  type: "response_item", timestamp: "2026-11-17T00:00:01Z",
  payload: { type: "function_call_output", id, call_id: id, output: fill.repeat(2048) },
});
const isHash = (name: string): boolean => /^[0-9a-f]{64}$/.test(name);
const stores = (store: string): string[] => readdirSync(store).filter(isHash).sort();
const manifestOf = (directory: string): Row => JSON.parse(readFileSync(join(directory, "manifest-v2.json"), "utf8"));
const published = (directory: string, file: "rollout.jsonl" | "messages-v1.jsonl"): Buffer => {
  const manifest = manifestOf(directory);
  return readFileSync(join(directory, file)).subarray(0, (file === "rollout.jsonl" ? manifest.rolloutBytes : manifest.messagesBytes) as number);
};
const parsedLines = (bytes: Buffer | string): Row[] => bytes.toString().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const nonTitle = (rows: Row[]): Row[] => rows.filter((row) => row.type !== "custom-title");
const titles = (rows: Row[]): unknown[] => rows.filter((row) => row.type === "custom-title").map((row) => row.customTitle);
const oneShot = (text: string) => parsedLines(convertCodexLines(text.split("\n").slice(0, -1)).messages);
const count = (db: Database, sql: string, ...args: (string | number)[]): number =>
  (db.query(sql).get(...args) as { n: number }).n;
const recordsOf = (db: Database, path: string): { line_no: number; raw: string }[] =>
  db.query<{ line_no: number; raw: string; payload_state: number | null }, [string]>(
    "SELECT r.line_no, r.raw, r.payload_state FROM records r JOIN sources s ON s.id=r.source_id WHERE s.path=? ORDER BY r.line_no",
  ).all(path).map((row) => ({ line_no: row.line_no, raw: restoredRaw(db)(row.raw, row.payload_state) }));

const fixture = () => {
  const root = tempDir(), codex = join(root, "codex"), store = join(root, "store");
  const db = openDatabase(join(root, "logs.sqlite"));
  const source = join(codex, "sessions/2026/11/17/rollout.jsonl");
  const convert = () => convertCodexLogs(codex, store);
  const importAll = () => importSources(db, listCodexSources(store), { now: () => "2026-11-17T00:00:00Z" });
  return { root, codex, store, db, source, convert, importAll };
};

// A snapshot written by the rules before docs/adr/0041 (manifest-v1.json only).
const v1Snapshot = (store: string, text: string, sourcePath: string): string => {
  const name = sha(text), directory = join(resolve(store), name);
  const converted = convertCodexLines(text === "" ? [] : text.split("\n").slice(0, -1));
  writeFile(join(directory, "rollout.jsonl"), text);
  writeFile(join(directory, "messages-v1.jsonl"), converted.messages);
  writeFile(join(directory, "manifest-v1.json"), `${JSON.stringify({ converterVersion: 1, sha256: name, sourcePath,
    sessions: converted.messageCount > 0 ? 1 : 0, messageLines: converted.messageCount, warnings: converted.warnings.length, status: converted.status })}\n`);
  return directory;
};

const LINES = [meta(), say("a1", "assistant first"), say("u1", "the first user words", "user"), big("t1", "x"), say("a2", "assistant second"), say("u2", "later user words", "user")];

describe("ADR 0041 appending to one store", () => {
  test("ADR 0041 I1, I4, I5: appending one line at a time keeps one store whose published range is the head of the source", () => {
    const f = fixture();
    let previous: Buffer | null = null;
    for (let n = 1; n <= LINES.length; n++) {
      writeFile(f.source, jsonl(...LINES.slice(0, n)));
      expect(f.convert().status).toBe(0);
      expect(stores(f.store)).toHaveLength(1);
      const directory = join(f.store, stores(f.store)[0] as string);
      const rollout = published(directory, "rollout.jsonl");
      expect(rollout.equals(readFileSync(f.source))).toBe(true);
      if (previous !== null) expect(rollout.subarray(0, previous.length).equals(previous)).toBe(true);
      previous = rollout;
      expect(f.importAll().errors).toEqual([]);
      const rows = recordsOf(f.db, join(directory, "rollout.jsonl"));
      expect(rows.map((row) => row.line_no)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect(rows.map((row) => row.raw)).toEqual(rollout.toString().split("\n").slice(0, -1));
    }
    const directory = join(f.store, stores(f.store)[0] as string);
    const before = ["rollout.jsonl", "messages-v1.jsonl", "manifest-v2.json"].map((name) => readFileSync(join(directory, name)));
    expect(f.convert().published).toBe(0);
    expect(["rollout.jsonl", "messages-v1.jsonl", "manifest-v2.json"].map((name) => readFileSync(join(directory, name)))).toEqual(before);
    expect(f.importAll().recordsAdded).toBe(0);
    expect(readdirSync(directory).sort()).toEqual(["manifest-v2.json", "messages-v1.jsonl", "rollout.jsonl"]);
  });

  test("ADR 0041 I2, I3: messages converted line by line match a one-shot conversion, including a title found later", () => {
    const f = fixture();
    for (let n = 1; n <= LINES.length; n++) {
      const text = jsonl(...LINES.slice(0, n));
      writeFile(f.source, text);
      f.convert();
      const directory = join(f.store, stores(f.store)[0] as string);
      const rows = parsedLines(published(directory, "messages-v1.jsonl"));
      const expected = oneShot(text);
      expect(nonTitle(rows)).toEqual(nonTitle(expected));
      expect(titles(rows).at(-1)).toEqual(titles(expected).at(-1));
      expect(manifestOf(directory).title ?? undefined).toEqual(titles(expected).at(-1));
    }
    const directory = join(f.store, stores(f.store)[0] as string);
    expect(titles(parsedLines(published(directory, "messages-v1.jsonl")))).toEqual(["s1", "the first user words"]);

    const g = fixture();
    writeFile(g.source, jsonl(meta()));
    g.convert();
    const only = join(g.store, stores(g.store)[0] as string);
    expect(readFileSync(join(only, "messages-v1.jsonl"), "utf8")).toBe("");
    expect(manifestOf(only)).toMatchObject({ title: null, rolloutLines: 1, messageLines: 0, lastSourceOrder: 0, sessions: 0 });
  });

  test("ADR 0041 I1, I5: empty files, a session_meta line alone and an incomplete tail", () => {
    const f = fixture();
    writeFile(f.source, "");
    expect(f.convert().status).toBe(0);
    expect(stores(f.store)).toEqual([sha("")]);
    const empty = join(f.store, sha(""));
    expect(manifestOf(empty)).toMatchObject({ firstLineSha256: null, rolloutBytes: 0, rolloutLines: 0, messagesBytes: 0 });
    writeFile(f.source, jsonl(meta()));
    f.convert();
    expect(stores(f.store)).toHaveLength(2);
    expect(readFileSync(join(empty, "rollout.jsonl"), "utf8")).toBe("");
    const grown = join(f.store, stores(f.store).find((name) => name !== sha("")) as string);
    expect(manifestOf(grown)).toMatchObject({ firstLineSha256: sha(`${JSON.stringify(meta())}\n`), rolloutLines: 1, title: null });
    writeFile(f.source, `${jsonl(meta(), say("a1", "complete"))}{"type":"response_item","payl`);
    f.convert();
    expect(stores(f.store)).toHaveLength(2);
    expect(readFileSync(join(grown, "rollout.jsonl"), "utf8")).toBe(jsonl(meta(), say("a1", "complete")));
    expect(f.importAll().errors).toEqual([]);
    expect(recordsOf(f.db, join(grown, "rollout.jsonl"))).toHaveLength(2);
    expect(recordsOf(f.db, join(empty, "rollout.jsonl"))).toHaveLength(0);
  });

  test("ADR 0041 I4, I7: a shorter input with the same head changes nothing and a rewritten head makes a new store", () => {
    const f = fixture();
    writeFile(f.source, jsonl(...LINES));
    f.convert();
    const [name] = stores(f.store);
    const directory = join(f.store, name as string);
    const snapshot = () => readdirSync(directory).sort().map((file) => [file, sha(readFileSync(join(directory, file)))]);
    const before = snapshot();
    writeFile(f.source, jsonl(...LINES.slice(0, 3)));
    expect(f.convert().published).toBe(0);
    expect(stores(f.store)).toEqual([name as string]);
    expect(snapshot()).toEqual(before);
    const text = jsonl(...LINES);
    writeFile(f.source, `[${text.slice(1)}`);
    f.convert();
    expect(stores(f.store)).toHaveLength(2);
    expect(snapshot()).toEqual(before);
  });

  test("ADR 0041 I1, I2, I5, I6: a write stopped before the manifest is never imported and is rewritten without duplicates", () => {
    for (const step of ["rollout.jsonl", "messages-v1.jsonl"]) {
      const f = fixture();
      writeFile(f.source, jsonl(...LINES.slice(0, 2)));
      f.convert();
      expect(f.importAll().errors).toEqual([]);
      const directory = join(f.store, stores(f.store)[0] as string);
      const manifestBefore = readFileSync(join(directory, "manifest-v2.json"));
      writeFile(f.source, jsonl(...LINES.slice(0, 4)));
      const stopped = convertCodexLogs(f.codex, f.store, (name) => { if (name === step) throw new Error("injected stop"); });
      expect(stopped.status).toBe(1);
      expect(readFileSync(join(directory, "manifest-v2.json")).equals(manifestBefore)).toBe(true);
      expect(statSync(join(directory, "rollout.jsonl")).size).toBeGreaterThan(manifestOf(directory).rolloutBytes as number);
      // A torn line beyond the published range as well.
      appendFileSync(join(directory, "rollout.jsonl"), '{"type":"torn');
      expect(f.importAll().errors).toEqual([]);
      expect(recordsOf(f.db, join(directory, "rollout.jsonl"))).toHaveLength(2);
      expect(nonTitle(recordsOf(f.db, join(directory, "messages-v1.jsonl")).map((row) => JSON.parse(row.raw)))).toHaveLength(1);
      expect(f.convert().status).toBe(0);
      expect(readFileSync(join(directory, "rollout.jsonl")).equals(readFileSync(f.source))).toBe(true);
      expect(f.importAll().errors).toEqual([]);
      const rollout = recordsOf(f.db, join(directory, "rollout.jsonl"));
      expect(rollout.map((row) => row.raw)).toEqual(readFileSync(f.source, "utf8").split("\n").slice(0, -1));
      const messages = recordsOf(f.db, join(directory, "messages-v1.jsonl")).map((row) => JSON.parse(row.raw));
      expect(nonTitle(messages)).toEqual(nonTitle(oneShot(jsonl(...LINES.slice(0, 4)))));
    }
  });

  test("ADR 0041 I8: a held lock stops the conversion with status 1, a killed holder releases it, and two conversions append once", async () => {
    const f = fixture();
    writeFile(f.source, jsonl(...LINES.slice(0, 2)));
    f.convert();
    const directory = join(f.store, stores(f.store)[0] as string);
    const env = isolatedEnv({ HOME: f.root, AI_CHAT_LOGS_CODEX_DIR: f.codex, AI_CHAT_LOGS_CODEX_STORE: f.store });
    const convertCli = () => Bun.spawn([join(repoRoot, "src/cli/codex-log-convert.ts")], { env, stdout: "pipe", stderr: "pipe" });
    writeFile(f.source, jsonl(...LINES.slice(0, 3)));
    const before = readdirSync(directory).map((file) => sha(readFileSync(join(directory, file))));
    const holder = new Database(join(f.store, ".lock.sqlite"));
    holder.run("BEGIN EXCLUSIVE");
    const started = Date.now();
    const blocked = convertCli();
    expect(await blocked.exited).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    expect(readdirSync(directory).map((file) => sha(readFileSync(join(directory, file))))).toEqual(before);
    holder.run("COMMIT");
    holder.close();

    const script = join(f.root, "hold.ts");
    writeFileSync(script, `import { Database } from "bun:sqlite";\nconst db = new Database(${JSON.stringify(join(f.store, ".lock.sqlite"))});\ndb.run("BEGIN EXCLUSIVE");\nconsole.log("held");\nawait Bun.sleep(60_000);\n`);
    const killed = Bun.spawn(["bun", script], { stdout: "pipe" });
    const reader = killed.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    killed.kill("SIGKILL");
    await killed.exited;
    expect(await convertCli().exited).toBe(0);
    expect(published(directory, "rollout.jsonl").equals(readFileSync(f.source))).toBe(true);

    writeFile(f.source, jsonl(...LINES));
    expect(await Promise.all([convertCli().exited, convertCli().exited])).toEqual([0, 0]);
    expect(stores(f.store)).toHaveLength(1);
    expect(readFileSync(join(directory, "rollout.jsonl")).equals(readFileSync(f.source))).toBe(true);
    expect(nonTitle(parsedLines(published(directory, "messages-v1.jsonl")))).toEqual(nonTitle(oneShot(jsonl(...LINES))));
    expect(f.importAll().errors).toEqual([]);
    expect(recordsOf(f.db, join(directory, "rollout.jsonl"))).toHaveLength(LINES.length);
  }, 30_000);

  test("ADR 0041 I1: of two candidates of the same size, the one with the smallest name is appended to", () => {
    const f = fixture();
    const text = jsonl(...LINES.slice(0, 2));
    const converted = convertCodexLines(text.split("\n").slice(0, -1));
    const manifest = (sourcePath: string) => ({ converterVersion: 1, sourcePath, firstLineSha256: sha(`${JSON.stringify(meta())}\n`),
      rolloutBytes: Buffer.byteLength(text), rolloutLines: 2, rolloutSha256: sha(text), messagesBytes: Buffer.byteLength(converted.messages),
      messageLines: 1, lastSourceOrder: 2, title: "s1", sessions: 1, warnings: 0, status: 0 });
    for (const name of ["b".repeat(64), "a".repeat(64)]) {
      writeFile(join(f.store, name, "rollout.jsonl"), text);
      writeFile(join(f.store, name, "messages-v1.jsonl"), converted.messages);
      writeFile(join(f.store, name, "manifest-v2.json"), JSON.stringify(manifest(f.source)));
    }
    writeFile(f.source, jsonl(...LINES.slice(0, 4)));
    expect(f.convert().status).toBe(0);
    expect(readFileSync(join(f.store, "a".repeat(64), "rollout.jsonl"), "utf8")).toBe(jsonl(...LINES.slice(0, 4)));
    expect(readFileSync(join(f.store, "b".repeat(64), "rollout.jsonl"), "utf8")).toBe(text);
    expect(stores(f.store)).toHaveLength(2);
  });

  test("ADR 0041 I6, I14: a store with manifest-v1.json alone gets manifest-v2.json before it grows and is not imported again", () => {
    const f = fixture();
    const text = jsonl(...LINES.slice(0, 3));
    const directory = v1Snapshot(f.store, text, f.source);
    const messagesBefore = readFileSync(join(directory, "messages-v1.jsonl"));
    expect(f.importAll().errors).toEqual([]);
    const rowids = () => f.db.query<{ rowid: number; line_no: number }, [string]>(
      "SELECT r.rowid, r.line_no FROM records r JOIN sources s ON s.id=r.source_id WHERE s.path=? ORDER BY r.line_no").all(join(directory, "rollout.jsonl"));
    const first = rowids();
    writeFile(f.source, jsonl(...LINES));
    expect(f.convert().status).toBe(0);
    expect(stores(f.store)).toEqual([sha(text)]);
    expect(manifestOf(directory)).toMatchObject({ sourcePath: f.source, rolloutLines: LINES.length });
    expect(readFileSync(join(directory, "rollout.jsonl")).subarray(0, Buffer.byteLength(text)).toString()).toBe(text);
    expect(readFileSync(join(directory, "messages-v1.jsonl")).subarray(0, messagesBefore.length).equals(messagesBefore)).toBe(true);
    expect(f.importAll().errors).toEqual([]);
    expect(rowids().slice(0, 3)).toEqual(first);
    expect(rowids().map((row) => row.line_no)).toEqual(Array.from({ length: LINES.length }, (_, i) => i + 1));
    expect(count(f.db, "SELECT count(*) n FROM sources WHERE path=?", join(directory, "rollout.jsonl"))).toBe(1);
  });

  test("ADR 0041 I13: codex-log-sources lists stores with manifest-v2.json alone and never the .dedupe- stores, and conversion never appends to them", () => {
    const f = fixture();
    writeFile(f.source, jsonl(...LINES.slice(0, 2)));
    f.convert();
    const [name] = stores(f.store);
    expect(readdirSync(join(f.store, name as string))).not.toContain("manifest-v1.json");
    const env = isolatedEnv({ HOME: f.root, AI_CHAT_LOGS_CODEX_STORE: f.store });
    const listed = () => Bun.spawnSync([join(repoRoot, "src/cli/codex-log-sources.ts")], { env }).stdout.toString().split("\n").filter(Boolean);
    expect(listed()).toEqual([
      `codex/conversation\t${join(resolve(f.store), name as string, "messages-v1.jsonl")}`,
      `codex/rollout\t${join(resolve(f.store), name as string, "rollout.jsonl")}`,
    ]);
    renameSync(join(f.store, name as string), join(f.store, `.dedupe-${name}`));
    expect(listed()).toEqual([]);
    writeFile(f.source, jsonl(...LINES.slice(0, 4)));
    f.convert();
    expect(readFileSync(join(f.store, `.dedupe-${name}`, "rollout.jsonl"), "utf8")).toBe(jsonl(...LINES.slice(0, 2)));
    expect(stores(f.store)).toEqual([sha(jsonl(...LINES.slice(0, 4)))]);
  });

  test("ADR 0041 I1: saveCodexSnapshot used by the pre-compaction hook appends to the same store", () => {
    const f = fixture();
    writeFile(f.source, jsonl(...LINES.slice(0, 2)));
    const one = saveCodexSnapshot(f.source, resolve(f.store));
    appendFileSync(f.source, jsonl(LINES[2]));
    const two = saveCodexSnapshot(f.source, resolve(f.store));
    expect(two.directory).toBe(one.directory);
    expect(two.published).toBe(true);
    expect(saveCodexSnapshot(f.source, resolve(f.store)).published).toBe(false);
  });
});

// --- codex-store-dedupe ---

const SOURCE = "/home/user/.codex/sessions/2026/11/17/rollout.jsonl";
const PARTS = [jsonl(...LINES.slice(0, 2)), jsonl(...LINES.slice(0, 4)), jsonl(...LINES)];
const NOW = () => "2026-11-17T00:00:00Z";

const dedupeFixture = (build: (store: string) => string[] = (store) => PARTS.map((text) => v1Snapshot(store, text, SOURCE))) => {
  const root = tempDir(), store = join(root, "store"), dbPath = join(root, "logs.sqlite");
  const directories = build(store);
  const db = openDatabase(dbPath);
  expect(importSources(db, listCodexSources(store), { now: NOW }).errors).toEqual([]);
  return { root, store, dbPath, db, directories };
};

const rawsOf = (db: Database, directory: string, file: string): string[] => recordsOf(db, join(directory, file)).map((row) => row.raw);

const dumpDb = (db: Database, root: string): unknown => {
  const rel = (value: unknown) => typeof value === "string" ? value.split(root).join("<root>") : value;
  const table = (sql: string) => db.query(sql).all().map((row) => Object.fromEntries(Object.entries(row as Row).map(([k, v]) => [k, rel(v)])));
  return {
    sources: table("SELECT kind, path, generation, consumed_bytes, consumed_lines, head_sha256 FROM sources ORDER BY path, generation"),
    records: table("SELECT s.path, r.line_no, r.raw, r.payload_state, r.type, r.uuid, r.session_id FROM records r JOIN sources s ON s.id=r.source_id ORDER BY s.path, r.line_no"),
    texts: table("SELECT rowid, text FROM record_texts ORDER BY rowid").length,
    toolTexts: table("SELECT rowid FROM record_tool_texts ORDER BY rowid").length,
    payloads: table("SELECT sha256 FROM payloads ORDER BY sha256"),
    summaries: table("SELECT * FROM session_summaries ORDER BY provider, session_id"),
    presentation: table("SELECT session_id, category, display_title, snapshot_sha256, rule_version FROM codex_session_presentation ORDER BY session_id"),
    items: table("SELECT session_id, uuid, encrypted_block_indexes FROM codex_item_presentation ORDER BY session_id, uuid"),
  };
};

const treeHash = (directory: string): string[] => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return `${path.slice(directory.length)}\t${sha(readFileSync(path))}`;
    }).sort();
};

describe("ADR 0041 codex-store-dedupe", () => {
  test("ADR 0041 I9: the deleted rows remain as rows of the kept store and unsafe snapshots are kept with a reason", () => {
    const f = dedupeFixture();
    const [s1, s2, s3] = f.directories as [string, string, string];
    const deleted = [s1, s2].flatMap((d) => [...rawsOf(f.db, d, "rollout.jsonl"), ...rawsOf(f.db, d, "messages-v1.jsonl")
      .filter((raw) => JSON.parse(raw).type !== "custom-title")]);
    const report = dedupeCodexStore(f.db, f.store, { dryRun: false });
    expect(report.deleted.map((d) => d.directory).sort()).toEqual([s1, s2].sort());
    expect(stores(f.store)).toEqual([s3.split("/").at(-1) as string]);
    const kept = new Set([...rawsOf(f.db, s3, "rollout.jsonl"), ...rawsOf(f.db, s3, "messages-v1.jsonl")]);
    expect(deleted.every((raw) => kept.has(raw))).toBe(true);
    expect(count(f.db, "SELECT count(*) n FROM sources WHERE path LIKE ? OR path LIKE ?", `${s1}%`, `${s2}%`)).toBe(0);
    expect(existsSync(join(s3, "manifest-v2.json"))).toBe(true);
    expect(count(f.db, "SELECT count(*) n FROM session_messages WHERE provider='codex'")).toBe(nonTitle(oneShot(PARTS[2] as string)).length);

    const notPrefix = dedupeFixture((store) => [v1Snapshot(store, jsonl(meta(), say("a1", "rewritten")), SOURCE), ...PARTS.slice(1).map((t) => v1Snapshot(store, t, SOURCE))]);
    const r1 = dedupeCodexStore(notPrefix.db, notPrefix.store, { dryRun: false });
    expect(r1.deleted).toHaveLength(1);
    expect(r1.kept.find((k) => k.directory === notPrefix.directories[0])?.reason).toContain("prefix");
    expect(existsSync(notPrefix.directories[0] as string)).toBe(true);

    const extraMessage = dedupeFixture((store) => {
      const directories = PARTS.map((t) => v1Snapshot(store, t, SOURCE));
      appendFileSync(join(directories[1] as string, "messages-v1.jsonl"), `${JSON.stringify({ type: "assistant", uuid: "only-here", sessionId: "s1", message: { role: "assistant", content: [] } })}\n`);
      return directories;
    });
    const r2 = dedupeCodexStore(extraMessage.db, extraMessage.store, { dryRun: false });
    expect(r2.deleted.map((d) => d.directory)).toEqual([extraMessage.directories[0]]);
    expect(r2.kept.find((k) => k.directory === extraMessage.directories[1])?.reason).toContain("messages");

    const notImported = dedupeFixture((store) => PARTS.slice(0, 2).map((t) => v1Snapshot(store, t, SOURCE)));
    v1Snapshot(notImported.store, PARTS[2] as string, SOURCE);
    const r3 = dedupeCodexStore(notImported.db, notImported.store, { dryRun: false });
    expect(r3.deleted).toEqual([]);
    expect(stores(notImported.store)).toHaveLength(3);
    expect(r3.kept.some((k) => k.reason.includes("not imported"))).toBe(true);

    const generations = dedupeFixture();
    generations.db.query("INSERT INTO sources (kind, path, generation, first_seen_at, last_seen_at) VALUES ('codex/rollout', ?, 1, 't', 't')")
      .run(join(generations.directories[0] as string, "rollout.jsonl"));
    const r4 = dedupeCodexStore(generations.db, generations.store, { dryRun: false });
    expect(r4.deleted.map((d) => d.directory)).toEqual([generations.directories[1]]);
    expect(r4.kept.find((k) => k.directory === generations.directories[0])?.reason).toContain("generation");
  });

  test("ADR 0041 I10: payloads no record points to are deleted and those still pointed to remain", () => {
    const f = dedupeFixture();
    const referenced = (db: Database): Set<string> => new Set(db.query<{ raw: string }, []>("SELECT raw FROM records WHERE payload_state=1").all()
      .flatMap((row) => [...row.raw.matchAll(/ai-chat-logs-payload:([0-9a-f]{64})/g)].map((m) => m[1] as string)));
    expect(referenced(f.db).size).toBeGreaterThan(0);
    f.db.query("INSERT INTO payloads (sha256, size, encoding, content) VALUES (?, 1, 'zstd', x'00')").run("f".repeat(64));
    dedupeCodexStore(f.db, f.store, { dryRun: false });
    const remaining = new Set(f.db.query<{ sha256: string }, []>("SELECT sha256 FROM payloads").all().map((row) => row.sha256));
    expect(remaining).toEqual(referenced(f.db));
    expect(remaining.has("f".repeat(64))).toBe(false);
    expect(() => rawsOf(f.db, f.directories[2] as string, "rollout.jsonl")).not.toThrow();
  });

  test("ADR 0041 I11: --dry-run changes neither the database nor the store", () => {
    const f = dedupeFixture();
    f.db.query("INSERT INTO payloads (sha256, size, encoding, content) VALUES (?, 1, 'zstd', x'00')").run("f".repeat(64));
    f.db.close();
    const before = [sha(readFileSync(f.dbPath)), ...treeHash(f.store)];
    const env = isolatedEnv({ HOME: f.root, AI_CHAT_LOGS_DB: f.dbPath, AI_CHAT_LOGS_CODEX_STORE: f.store });
    const run = Bun.spawnSync([join(repoRoot, "src/cli/codex-store-dedupe.ts"), "--dry-run"], { env });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain(f.directories[0] as string);
    expect([sha(readFileSync(f.dbPath)), ...treeHash(f.store)]).toEqual(before);
  });

  test("ADR 0041 I12: rerunning after a stop at any step ends in the same database and store as an uninterrupted run", () => {
    const build = (store: string) => [
      ...PARTS.map((text) => v1Snapshot(store, text, SOURCE)),
      ...[jsonl(meta("s2"), say("b1", "other", "user")), jsonl(meta("s2"), say("b1", "other", "user"), say("b2", "reply"))]
        .map((text) => v1Snapshot(store, text, "/home/user/.codex/sessions/other.jsonl")),
    ];
    const whole = dedupeFixture(build);
    dedupeCodexStore(whole.db, whole.store, { dryRun: false });
    const expected = { db: dumpDb(whole.db, whole.root), store: treeHash(whole.store) };
    const stops: [number, number][] = [[1, 1], [2, 1], [2, 2], [3, 1], [3, 2], [4, 1], [5, 1], [5, 2]];
    for (const [step, nth] of stops) {
      const f = dedupeFixture(build);
      let seen = 0;
      expect(() => dedupeCodexStore(f.db, f.store, { dryRun: false, afterStep: (s) => {
        if (s === step && ++seen === nth) throw new Error(`stopped after step ${step}`);
      } })).toThrow(`stopped after step ${step}`);
      dedupeCodexStore(f.db, f.store, { dryRun: false });
      expect({ step, nth, db: dumpDb(f.db, f.root), store: treeHash(f.store) }).toEqual({ step, nth, ...expected });
    }
  });
});
