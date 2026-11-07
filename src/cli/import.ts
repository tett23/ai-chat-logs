#!/usr/bin/env -S bun --no-env-file
// docs/adr/0001: read "<kind>\t<path>" lines from stdin and import them incrementally.
import { parseArgs } from "node:util";
import { openDatabase } from "../db.ts";
import { loadEnvFile } from "../env.ts";
import { importSources, parseSourceList } from "../import.ts";
import { convertPendingPayloads } from "../payloads.ts";
import { defaultDatabasePath } from "../paths.ts";

loadEnvFile();

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    "mark-missing": { type: "boolean", default: false },
  },
});

const db = openDatabase(values.db ?? defaultDatabasePath(process.env));
const summary = importSources(db, parseSourceList(await Bun.stdin.text()), { markMissing: values["mark-missing"] });
// docs/adr/0031: records imported before schema 6
const converted = convertPendingPayloads(db);
db.close();

summary.errors.forEach(({ path, message }) => console.error(`error\t${path}\t${message}`));
console.error(
  `run=${summary.runId} sources=${summary.sourcesSeen} records=${summary.recordsAdded} blobs=${summary.blobsAdded} errors=${summary.errors.length}`,
);
if (converted > 0) console.error(`payloads: converted ${converted} records`);
process.exitCode = summary.errors.length ? 1 : 0;
