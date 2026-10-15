import type { Database } from "bun:sqlite";

// docs/adr/0003, docs/adr/0005: keep record_texts and session_summaries in step with imported records.
// The rules are the views in schema/0002-search-and-summaries.sql.

export type SessionKey = { provider: string; sessionId: string };

export const maxRecordRowid = (db: Database): number =>
  db.query<{ m: number | null }, []>("SELECT max(rowid) m FROM records").get()?.m ?? 0;

export const indexTextsAfter = (db: Database, rowid: number): void => {
  db.query("INSERT INTO record_texts (rowid, text) SELECT record_rowid, text FROM record_text_source WHERE record_rowid > ? AND text <> ''").run(rowid);
};

export const sessionsAfter = (db: Database, rowid: number): SessionKey[] =>
  db
    .query<SessionKey, [number]>(
      `SELECT DISTINCT s.provider AS provider, r.session_id AS sessionId
       FROM records r JOIN sources s ON s.id = r.source_id
       WHERE r.rowid > ? AND r.session_id IS NOT NULL`,
    )
    .all(rowid);

export const rebuildSessions = (db: Database, keys: readonly SessionKey[]): void => {
  const remove = db.query("DELETE FROM session_summaries WHERE provider = ? AND session_id = ?");
  const insert = db.query("INSERT INTO session_summaries SELECT * FROM session_summary_source WHERE provider = ? AND session_id = ?");
  keys.forEach(({ provider, sessionId }) => {
    remove.run(provider, sessionId);
    insert.run(provider, sessionId);
  });
};

// Sessions whose summaries depend on a new version of a file of the given kind.
const SESSION_FILE_PROVIDERS: Record<string, string> = {
  "claude-desktop/session": "claude-code",
  "claude-cowork/session": "claude-cowork",
};

export const sessionsOfFile = (kind: string, content: Uint8Array): SessionKey[] => {
  const provider = SESSION_FILE_PROVIDERS[kind];
  if (provider === undefined) return [];
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(content));
    const id = (value as { cliSessionId?: unknown } | null)?.cliSessionId;
    return typeof id === "string" ? [{ provider, sessionId: id }] : [];
  } catch {
    return [];
  }
};
