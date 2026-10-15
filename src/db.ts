import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import initial from "../schema/0001-initial.sql" with { type: "text" };
import searchAndSummaries from "../schema/0002-search-and-summaries.sql" with { type: "text" };
import otherProviders from "../schema/0003-other-providers.sql" with { type: "text" };

// docs/adr/0001: migrations are applied in order; PRAGMA user_version holds the applied count.
const MIGRATIONS: readonly string[] = [initial, searchAndSummaries, otherProviders];

export const SCHEMA_VERSION = MIGRATIONS.length;

const createPrivateFile = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
};

const userVersion = (db: Database): number =>
  db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;

const migrate = (db: Database): void => {
  MIGRATIONS.slice(userVersion(db)).forEach((sql, i, pending) => {
    db.transaction(() => {
      db.run(sql);
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION - pending.length + i + 1}`);
    }).immediate();
  });
};

export const openDatabase = (path: string): Database => {
  createPrivateFile(path);
  const db = new Database(path, { strict: true });
  db.run("PRAGMA busy_timeout = 10000");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
};
