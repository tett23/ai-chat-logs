// docs/adr/0011: read-only queries for chat-log over the views of schema/0002 and schema/0003.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type Block, toBlocks } from "./blocks.ts";
import { HIT_END, HIT_START, highlight, makeSnippet, type SearchPlan } from "./search.ts";

export const REQUIRED_SCHEMA_VERSION = 3;

// Errors that end chat-log with exit code 2 (usage, database, settings), and with 1 (no such session).
export type ExitError = Error & { exitCode: 1 | 2 };
export const exitError = (exitCode: 1 | 2, message: string): ExitError => Object.assign(new Error(message), { exitCode });
export const isExitError = (e: unknown): e is ExitError =>
  e instanceof Error && ((e as ExitError).exitCode === 1 || (e as ExitError).exitCode === 2);

export const openReadOnly = (path: string): Database => {
  if (!existsSync(path)) throw exitError(2, `データベースが見つかりません: ${path}。取り込み（bin/sync か ai-chat-logs-sync）を実行してください。`);
  const db = new Database(path, { readonly: true });
  const version = db.query<{ v: number }, []>("SELECT user_version v FROM pragma_user_version").get()?.v ?? 0;
  if (version < REQUIRED_SCHEMA_VERSION) {
    db.close();
    throw exitError(2, `データベースのスキーマが古いです（${version}、必要なのは ${REQUIRED_SCHEMA_VERSION}）。取り込み（bin/sync）を実行してください。`);
  }
  return db;
};

export type Filter = { provider?: string; cwd?: string; since?: string };

const escapeLike = (s: string): string => s.replace(/[%_\\]/g, (c) => `\\${c}`);

// SQL conditions and parameters of a filter; `table` holds provider and cwd, `time` the compared time column.
const conditions = (f: Filter, provider: string, cwd: string, time: string): [string[], SQLQueryBindings[]] => {
  const parts: [string, SQLQueryBindings[]][] = [
    ...(f.provider ? [[`${provider} = ?`, [f.provider]] as [string, SQLQueryBindings[]]] : []),
    ...(f.cwd ? [[`(${cwd} = ? OR ${cwd} LIKE ? ESCAPE '\\')`, [f.cwd, `${escapeLike(f.cwd.replace(/\/+$/, ""))}/%`]] as [string, SQLQueryBindings[]]] : []),
    ...(f.since ? [[`${time} > ?`, [f.since]] as [string, SQLQueryBindings[]]] : []),
  ];
  return [parts.map(([c]) => c), parts.flatMap(([, p]) => p)];
};

const where = (clauses: string[]): string => (clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "");

export type Session = {
  provider: string;
  session_id: string;
  title: string | null;
  cwd: string | null;
  first_at: string | null;
  last_at: string | null;
  message_count: number;
};

export const listSessions = (db: Database, f: Filter, limit: number, offset: number): Session[] => {
  const [clauses, params] = conditions(f, "provider", "cwd", "last_at");
  return db
    .query<Session, SQLQueryBindings[]>(
      `SELECT provider, session_id, title, cwd, first_at, last_at, message_count FROM session_summaries
       ${where(clauses)} ORDER BY last_at DESC, session_id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
};

export const sessionIds = (db: Database, prefix: string): string[] =>
  db
    .query<{ id: string }, [string]>("SELECT DISTINCT session_id id FROM session_summaries WHERE session_id LIKE ? ESCAPE '\\'")
    .all(`${escapeLike(prefix)}%`)
    .map((r) => r.id);

export type Message = {
  index: number;
  uuid: string | null;
  timestamp: string | null;
  role: string | null;
  model: string | null;
  is_sidechain: boolean;
  blocks: Block[];
};

const toMessage = (row: { idx: number; uuid: string | null; timestamp: string | null; raw: string }): Message => {
  const value = (() => {
    try {
      return JSON.parse(row.raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const message = (typeof value.message === "object" && value.message !== null ? value.message : {}) as Record<string, unknown>;
  return {
    index: row.idx,
    uuid: row.uuid,
    timestamp: row.timestamp,
    role: typeof message.role === "string" ? message.role : null,
    model: typeof message.model === "string" ? message.model : null,
    is_sidechain: value.isSidechain === true,
    blocks: toBlocks(message.content),
  };
};

export const messageCount = (db: Database, sessionId: string): number =>
  db.query<{ n: number }, [string]>("SELECT count(*) n FROM session_messages WHERE session_id = ?").get(sessionId)?.n ?? 0;

// Messages numbered from 1 in file and line order without copies, in [from, to].
export const sessionMessages = (db: Database, sessionId: string, from: number, to: number): Message[] =>
  db
    .query<{ idx: number; uuid: string | null; timestamp: string | null; raw: string }, [string, number, number]>(
      `SELECT x.idx, r.uuid, r.timestamp, r.raw
       FROM (SELECT record_rowid, row_number() OVER (ORDER BY path, generation, line_no) AS idx
             FROM session_messages WHERE session_id = ?) x
       JOIN records r ON r.rowid = x.record_rowid
       WHERE x.idx BETWEEN ? AND ? ORDER BY x.idx`,
    )
    .all(sessionId, from, to)
    .map(toMessage);

export type Hit = {
  provider: string;
  session_id: string | null;
  index: number | null;
  uuid: string | null;
  timestamp: string | null;
  role: string | null;
  title: string | null;
  snippet: string;
};

const SNIPPET_CONTEXT = 32;

// The number `show` gives to a record.
const indexOf = (db: Database, rowid: number): number | null => {
  const at = db
    .query<{ provider: string; session_id: string; path: string; generation: number; line_no: number }, [number]>(
      "SELECT provider, session_id, path, generation, line_no FROM session_messages WHERE record_rowid = ?",
    )
    .get(rowid);
  if (!at) return null;
  return (
    db
      .query<{ n: number }, [string, string, string, number, number]>(
        "SELECT count(*) n FROM session_messages WHERE provider = ? AND session_id = ? AND (path, generation, line_no) <= (?, ?, ?)",
      )
      .get(at.provider, at.session_id, at.path, at.generation, at.line_no)?.n ?? null
  );
};

export const search = (db: Database, plan: SearchPlan, f: Filter, limit: number, offset: number): Hit[] => {
  if (plan.terms.length === 0) return [];
  const snippet = plan.fts !== null ? `snippet(record_texts, 0, '${HIT_START}', '${HIT_END}', '…', 16)` : "record_texts.text";
  const [filterClauses, filterParams] = conditions(f, "s.provider", "ss.cwd", "r.timestamp");
  const clauses = [
    ...(plan.fts !== null ? ["record_texts MATCH ?"] : []),
    ...plan.likes.map(() => "record_texts.text LIKE ? ESCAPE '\\'"),
    "NOT EXISTS (SELECT 1 FROM copied_records c WHERE c.record_rowid = r.rowid)",
    ...filterClauses,
  ];
  const params: SQLQueryBindings[] = [...(plan.fts !== null ? [plan.fts] : []), ...plan.likes, ...filterParams, limit, offset];
  type Row = { provider: string; session_id: string | null; uuid: string | null; timestamp: string | null; role: string | null; title: string | null; snip: string; rid: number };
  return db
    .query<Row, SQLQueryBindings[]>(
      `SELECT s.provider, r.session_id, r.uuid, r.timestamp, r.raw ->> '$.message.role' AS role, ss.title, ${snippet} AS snip, r.rowid AS rid
       FROM record_texts
       JOIN records r ON r.rowid = record_texts.rowid
       JOIN sources s ON s.id = r.source_id
       LEFT JOIN session_summaries ss ON ss.provider = s.provider AND ss.session_id = r.session_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.timestamp DESC, r.rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params)
    .map((row) => ({
      provider: row.provider,
      session_id: row.session_id,
      index: indexOf(db, row.rid),
      uuid: row.uuid,
      timestamp: row.timestamp,
      role: row.role,
      title: row.title,
      snippet: plan.fts !== null ? highlight(row.snip) : makeSnippet(row.snip, plan.terms, SNIPPET_CONTEXT),
    }));
};
