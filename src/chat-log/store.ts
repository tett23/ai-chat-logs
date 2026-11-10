// docs/adr/0011: read-only queries for chat-log over the views of schema/0002 and schema/0003.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type Block, toBlocks } from "./blocks.ts";
import { restoredRaw } from "../payloads.ts";
import { makeSnippet, type SearchPlan } from "./search.ts";

// docs/adr/0021: record_tool_texts; docs/adr/0031: payloads.
export const REQUIRED_SCHEMA_VERSION = 7;

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

export type Filter = { provider?: string; cwd?: string; since?: string; until?: string };

const escapeLike = (s: string): string => s.replace(/[%_\\]/g, (c) => `\\${c}`);

// SQL conditions and parameters of a filter; `time` is compared with --since and `start` with --until
// (docs/adr/0018: for sessions, the first time, so that sessions overlapping the period remain).
const conditions = (f: Filter, provider: string, cwd: string, time: string, start: string = time): [string[], SQLQueryBindings[]] => {
  const parts: [string, SQLQueryBindings[]][] = [
    ...(f.provider ? [[`${provider} = ?`, [f.provider]] as [string, SQLQueryBindings[]]] : []),
    ...(f.cwd ? [[`(${cwd} = ? OR ${cwd} LIKE ? ESCAPE '\\')`, [f.cwd, `${escapeLike(f.cwd.replace(/\/+$/, ""))}/%`]] as [string, SQLQueryBindings[]]] : []),
    ...(f.since ? [[`${time} > ?`, [f.since]] as [string, SQLQueryBindings[]]] : []),
    ...(f.until ? [[`${start} < ?`, [f.until]] as [string, SQLQueryBindings[]]] : []),
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
  const [clauses, params] = conditions(f, "provider", "cwd", "last_at", "first_at");
  return db
    .query<Session, SQLQueryBindings[]>(
      `SELECT provider, session_id, title, cwd, first_at, last_at, message_count FROM session_summaries
       ${where(clauses)} ORDER BY last_at DESC, session_id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
};

// docs/adr/0026: the summary of one session, for the head of an export.
export const sessionSummary = (db: Database, provider: string, sessionId: string): Session | null =>
  db
    .query<Session, [string, string]>(
      "SELECT provider, session_id, title, cwd, first_at, last_at, message_count FROM session_summaries WHERE provider = ? AND session_id = ?",
    )
    .get(provider, sessionId);

export type SessionKey = { provider: string; session_id: string };
export const sessionIds = (db: Database, prefix: string, provider?: string): SessionKey[] =>
  db
    .query<SessionKey, [string, string | null, string | null]>("SELECT provider, session_id FROM session_summaries WHERE session_id LIKE ? ESCAPE '\\' AND (? IS NULL OR provider = ?) ORDER BY provider, session_id")
    .all(`${escapeLike(prefix)}%`, provider ?? null, provider ?? null);

export type Message = {
  index: number;
  uuid: string | null;
  timestamp: string | null;
  role: string | null;
  model: string | null;
  is_sidechain: boolean;
  original_id: string | null;
  version: string | null;
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
    original_id: typeof (value.openai as Record<string, unknown> | undefined)?.itemId === "string" ? (value.openai as Record<string, string>).itemId : null,
    version: typeof (value.openai as Record<string, unknown> | undefined)?.version === "string" ? (value.openai as Record<string, string>).version : null,
    blocks: toBlocks(message.content),
  };
};

export const messageCount = (db: Database, provider: string, sessionId: string): number =>
  db.query<{ n: number }, [string, string]>("SELECT count(*) n FROM session_messages WHERE provider = ? AND session_id = ?").get(provider, sessionId)?.n ?? 0;

// Codex snapshots may be stored at different paths. Their original physical order wins ties in time.
const messageOrder = `coalesce(timestamp, ''),
  CASE WHEN provider = 'codex' THEN CAST(raw ->> '$.sourceOrder' AS INTEGER) END,
  CASE WHEN provider = 'codex' THEN coalesce(raw ->> '$.uuid', '') ELSE path END,
  CASE WHEN provider = 'codex' THEN '' ELSE generation END,
  CASE WHEN provider = 'codex' THEN 0 ELSE line_no END`;

// Messages numbered from 1 in file and line order without copies, in [from, to].
// docs/adr/0031: raw is restored from payloads before it is read.
export const sessionMessages = (db: Database, provider: string, sessionId: string, from: number, to: number): Message[] => {
  const restore = restoredRaw(db);
  return db
    .query<{ idx: number; uuid: string | null; timestamp: string | null; raw: string; payload_state: number | null }, [string, string, number, number]>(
      `SELECT x.idx, r.uuid, r.timestamp, r.raw, r.payload_state
       FROM (SELECT record_rowid, row_number() OVER (ORDER BY ${messageOrder}) AS idx
             FROM session_messages WHERE provider = ? AND session_id = ?) x
       JOIN records r ON r.rowid = x.record_rowid
       WHERE x.idx BETWEEN ? AND ? ORDER BY x.idx`,
    )
    .all(provider, sessionId, from, to)
    .map((row) => toMessage({ ...row, raw: restore(row.raw, row.payload_state) }));
};

export type Hit = {
  provider: string;
  session_id: string | null;
  index: number | null;
  uuid: string | null;
  timestamp: string | null;
  role: string | null;
  title: string | null;
  snippet: string;
  /** docs/adr/0013: which kinds of blocks contain a term; docs/adr/0021: ["tool"] for a match only in tools. */
  matched_in: ("text" | "thinking" | "tool")[];
};

const lower = (s: string): string => s.toLowerCase();

// The kinds of blocks of a record that contain any of the terms (case-insensitively, like LIKE).
// Text and thinking are never taken out into payloads (docs/adr/0031), so raw needs no restoring here.
const matchedIn = (raw: string, terms: readonly string[]): ("text" | "thinking")[] => {
  const content = (() => {
    try {
      return (JSON.parse(raw) as { message?: { content?: unknown } }).message?.content;
    } catch {
      return undefined;
    }
  })();
  const blocks = toBlocks(content);
  const has = (kind: "text" | "thinking") =>
    blocks.some((b) => b.kind === kind && terms.some((t) => lower(b.text).includes(lower(t))));
  return (["text", "thinking"] as const).filter(has);
};

const SNIPPET_CONTEXT = 32;

// The numbers `show` gives to the records of `rows`, one query per session (docs/adr/0017).
// A record that is not a message (a copy) has no number.
const indexesOf = (db: Database, rows: readonly { provider: string; session_id: string | null; rid: number }[]): Map<number, number> => {
  const query = db.query<{ record_rowid: number; n: number }, [string, string, string]>(
    `SELECT record_rowid, n FROM (
       SELECT record_rowid, row_number() OVER (ORDER BY ${messageOrder}) n
       FROM session_messages WHERE provider = ? AND session_id = ?)
     WHERE record_rowid IN (SELECT value FROM json_each(?))`,
  );
  const sessions = Map.groupBy(
    rows.flatMap((r) => (r.session_id === null ? [] : [{ ...r, session_id: r.session_id }])),
    (r) => JSON.stringify([r.provider, r.session_id]),
  );
  return new Map(
    [...sessions.values()].flatMap((hits) =>
      query
        .all(hits[0]?.provider ?? "", hits[0]?.session_id ?? "", JSON.stringify(hits.map((h) => h.rid)))
        .map((r) => [r.record_rowid, r.n] as const),
    ),
  );
};

// docs/adr/0021: with `tools`, a record matches when its text or its tool text contains every term;
// a record matching in both counts as a match in its text.
export const search = (db: Database, plan: SearchPlan, f: Filter, limit: number, offset: number, tools = false): Hit[] => {
  if (plan.terms.length === 0) return [];
  const [filterClauses, filterParams] = conditions(f, "s.provider", "ss.cwd", "r.timestamp");
  const branch = (table: string, tool: number): [string, SQLQueryBindings[]] => [
    `SELECT rowid AS rid, text, ${tool} AS tool FROM ${table} WHERE ${[
      ...(plan.fts !== null ? [`${table} MATCH ?`] : []),
      ...plan.likes.map(() => "text LIKE ? ESCAPE '\\'"),
      // docs/adr/0022: excluded terms, looked for in the same text
      ...(plan.notFts !== null ? [`rowid NOT IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ?)`] : []),
      ...plan.notLikes.map(() => "text NOT LIKE ? ESCAPE '\\'"),
    ].join(" AND ")}`,
    [...(plan.fts !== null ? [plan.fts] : []), ...plan.likes, ...(plan.notFts !== null ? [plan.notFts] : []), ...plan.notLikes],
  ];
  const branches = [branch("record_texts", 0), ...(tools ? [branch("record_tool_texts", 1)] : [])];
  const clauses = ["NOT EXISTS (SELECT 1 FROM copied_records c WHERE c.record_rowid = r.rowid)", ...filterClauses];
  const params: SQLQueryBindings[] = [...branches.flatMap(([, p]) => p), ...filterParams, limit, offset];
  type Row = { provider: string; session_id: string | null; uuid: string | null; timestamp: string | null; role: string | null; title: string | null; snip: string; tool: number; rid: number; raw: string };
  const rows = db
    .query<Row, SQLQueryBindings[]>(
      `WITH matched AS (${branches.map(([sql]) => sql).join(" UNION ALL ")}),
            best AS (SELECT rid, text, min(tool) AS tool FROM matched GROUP BY rid)
       SELECT s.provider, r.session_id, r.uuid, r.timestamp, r.raw ->> '$.message.role' AS role, ss.title, best.text AS snip, best.tool, r.rowid AS rid, r.raw
       FROM best
       JOIN records r ON r.rowid = best.rid
       JOIN sources s ON s.id = r.source_id
       LEFT JOIN session_summaries ss ON ss.provider = s.provider AND ss.session_id = r.session_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.timestamp DESC, r.rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params);
  const indexes = indexesOf(db, rows);
  return rows.map((row) => ({
    provider: row.provider,
    session_id: row.session_id,
    index: indexes.get(row.rid) ?? null,
    uuid: row.uuid,
    timestamp: row.timestamp,
    role: row.role,
    title: row.title,
    snippet: makeSnippet(row.snip, plan.terms, SNIPPET_CONTEXT),
    matched_in: row.tool === 1 ? ["tool"] : matchedIn(row.raw, plan.terms),
  }));
};
