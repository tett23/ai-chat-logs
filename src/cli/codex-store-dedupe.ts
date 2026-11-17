#!/usr/bin/env -S bun --no-env-file
// docs/adr/0041: remove the existing duplicate Codex snapshots once. Stop the pm2 sync processes first.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { dedupeCodexStore } from "../codex-dedupe.ts";
import { openDatabase, SCHEMA_VERSION } from "../db.ts";
import { loadEnvFile } from "../env.ts";
import { codexStore, defaultDatabasePath } from "../paths.ts";

loadEnvFile();
let dryRun: boolean;
try {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } }, strict: true, allowPositionals: false });
  dryRun = values["dry-run"] === true;
} catch {
  console.error("usage: codex-store-dedupe [--dry-run]");
  process.exit(2);
}

// A dry run never migrates nor writes the database.
const open = (path: string): Database => {
  if (!dryRun) return openDatabase(path);
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 10000");
  db.run("PRAGMA query_only = ON");
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version !== SCHEMA_VERSION) throw new Error(`the database schema is ${version}, not ${SCHEMA_VERSION}; run chat-log-import first`);
  return db;
};

try {
  const path = defaultDatabasePath(process.env);
  if (!existsSync(path)) throw new Error(`no database: ${path}`);
  const db = open(path);
  try {
    const report = dedupeCodexStore(db, codexStore(process.env), { dryRun });
    const action = dryRun ? "would-delete" : "deleted";
    for (const d of report.deleted) {
      console.log([action, d.directory, d.sourcePath, `sources=${d.sources}`, `records=${d.records}`, `raw_bytes=${d.rawBytes}`, `store_bytes=${d.storeBytes}`].join("\t"));
    }
    for (const k of report.kept) console.log(["kept", k.directory, k.sourcePath ?? "-", k.reason].join("\t"));
    const sum = (key: "sources" | "records" | "rawBytes" | "storeBytes") => report.deleted.reduce((n, d) => n + d[key], 0);
    console.error(`codex-store-dedupe:${dryRun ? " dry-run" : ""} stores=${report.deleted.length} sources=${sum("sources")} records=${sum("records")}`
      + ` raw_bytes=${sum("rawBytes")} store_bytes=${sum("storeBytes")} kept=${report.kept.length} payloads=${report.payloads}`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error(`codex-store-dedupe: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
