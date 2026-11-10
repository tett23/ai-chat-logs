// docs/adr/0037: reproducible display data, derived from immutable Codex snapshots.
import type { Database } from "bun:sqlite";
import { convertCodexLines } from "./codex.ts";
import { restoredRaw } from "./payloads.ts";

type Obj = Record<string, unknown>;
type Category = "normal" | "subagent" | "internal" | "unknown";
export type CodexClassification = {
  category: Category;
  parent_thread_id: string | null;
  agent_path: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  detail: string | null;
};
type Snapshot = { sourceId: number; sessionId: string; hash: string; bytes: number; maxRowid: number };
type StoredRow = { raw: string; payload_state: number | null; line_no: number };
type ConversationRow = { session_id: string; uuid: string | null; raw: string; payload_state: number | null; rowid: number };
type Existing = { snapshot_sha256: string | null; rule_version: number; source_record_max_rowid: number };

const VERSION = 1;
const PLACEHOLDER = "暗号化された内容は表示できない";
const obj = (x: unknown): Obj | null => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Obj : null;
const str = (x: unknown): string | null => typeof x === "string" ? x : null;
const arr = (x: unknown): unknown[] => Array.isArray(x) ? x : [];
const parse = (text: string): Obj | null => { try { return obj(JSON.parse(text)); } catch { return null; } };
const empty = (): CodexClassification => ({ category: "unknown", parent_thread_id: null, agent_path: null, agent_nickname: null, agent_role: null, detail: null });

export const classifyCodexSource = (source: unknown): CodexClassification => {
  if (["vscode", "exec", "cli"].includes(source as string)) return { ...empty(), category: "normal", detail: source as string };
  const subagent = obj(obj(source)?.subagent);
  if (subagent === null) return empty();
  const thread = obj(subagent.thread_spawn), other = str(subagent.other);
  if (thread !== null && other !== null) return empty();
  if (thread !== null) return {
    category: "subagent", parent_thread_id: str(thread.parent_thread_id), agent_path: str(thread.agent_path),
    agent_nickname: str(thread.agent_nickname), agent_role: str(thread.agent_role), detail: null,
  };
  if (other !== null) return { ...empty(), category: "internal", detail: other };
  return empty();
};

const stripInstructions = (text: string): string => {
  let rest = text.replace(/\r\n/g, "\n").trim();
  for (;;) {
    const instructions = /^#[ \t]*AGENTS\.md instructions[ \t]*\n(?:[ \t]*\n)*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/.exec(rest);
    const environment = /^<environment_context>[\s\S]*?<\/environment_context>/.exec(rest);
    const prefix = instructions?.[0] ?? environment?.[0];
    if (prefix === undefined) return rest.trim();
    rest = rest.slice(prefix.length).trimStart();
  }
};

export const codexDisplayTitle = (sessionId: string, rows: readonly unknown[]): string => {
  for (const raw of rows) {
    const record = obj(raw), payload = obj(record?.payload);
    if (record?.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") continue;
    const publicText = arr(payload.content).flatMap((block) => {
      const part = obj(block);
      return (part?.type === "input_text" || part?.type === "output_text") && typeof part.text === "string" ? [part.text] : [];
    }).join("\n");
    const title = stripInstructions(publicText).replace(/\n/g, " ").trim();
    if (title !== "") return Array.from(title).slice(0, 80).join("");
  }
  return sessionId;
};

// Mirror only the block positions in converter v1. Never infer from the visible string alone.
export const encryptedBlockIndexes = (item: unknown): number[] => {
  const value = obj(item);
  if (value?.type === "reasoning") {
    if (value.encrypted_content == null) return [];
    return [arr(value.summary).filter((part) => { const p = obj(part); return p?.type === "summary_text" && typeof p.text === "string"; }).length];
  }
  if (value?.type !== "message" && value?.type !== "agent_message") return [];
  if (value.type === "message" && !["user", "assistant"].includes(value.role as string)) return [];
  let index = 0;
  const found: number[] = [];
  for (const block of arr(value.content)) {
    const part = obj(block);
    if (part?.type === "encrypted_content") { found.push(index++); continue; }
    if ((part?.type === "input_text" || part?.type === "output_text") && typeof part.text === "string") index++;
  }
  return found;
};

const sourceHash = (path: string): string | null => /(?:^|[/\\])([0-9a-f]{64})[/\\]rollout\.jsonl$/.exec(path)?.[1] ?? null;

const snapshots = (db: Database, restore: ReturnType<typeof restoredRaw>): Map<string, Snapshot[]> => {
  const sourceRows = db.query<{ id: number; path: string; consumed_bytes: number; raw: string | null; payload_state: number | null; max_rowid: number }, []>(
    `SELECT s.id, s.path, s.consumed_bytes, first.raw, first.payload_state,
            COALESCE((SELECT max(rowid) FROM records WHERE source_id=s.id), 0) max_rowid
     FROM sources s LEFT JOIN records first ON first.source_id=s.id AND first.line_no=1
     WHERE s.kind='codex/rollout'`,
  ).all();
  const bySession = new Map<string, Snapshot[]>();
  for (const row of sourceRows) {
    const hash = sourceHash(row.path);
    if (hash === null || row.raw === null) continue;
    const first = parse(restore(row.raw, row.payload_state));
    const sessionId = first?.type === "session_meta" ? str(obj(first.payload)?.id) : null;
    if (sessionId === null || sessionId === "") continue;
    const list = bySession.get(sessionId) ?? [];
    list.push({ sourceId: row.id, sessionId, hash, bytes: row.consumed_bytes, maxRowid: row.max_rowid });
    bySession.set(sessionId, list);
  }
  return bySession;
};

const loadRows = (db: Database, sourceId: number, restore: ReturnType<typeof restoredRaw>): string[] => {
  const rows = db.query<StoredRow, [number]>("SELECT line_no, raw, payload_state FROM records WHERE source_id=? ORDER BY line_no").all(sourceId);
  const result: string[] = [];
  for (const row of rows) result[row.line_no - 1] = restore(row.raw, row.payload_state);
  for (let i = 0; i < result.length; i++) result[i] ??= "";
  return result;
};

const comparableContent = (row: Obj | null): string | null => {
  const content = obj(row?.message)?.content;
  return Array.isArray(content) ? JSON.stringify(content) : null;
};

export type PresentationError = { path: string; message: string };
export const rebuildCodexPresentation = (db: Database): PresentationError[] => {
  // Importers can also be used with a database pinned to an older schema in migration tests.
  if ((db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0) < 8) return [];
  const restore = restoredRaw(db);
  const bySession = snapshots(db, restore);
  const conversationHeads = db.query<{ session_id: string; max_rowid: number }, []>(
    `SELECT r.session_id, max(r.rowid) max_rowid
     FROM records r JOIN sources s ON s.id=r.source_id
     WHERE s.kind='codex/conversation' AND r.session_id IS NOT NULL GROUP BY r.session_id`,
  ).all();
  const byConversation = new Map(conversationHeads.map((row) => [row.session_id, row.max_rowid]));
  const sessions = [...new Set([...bySession.keys(), ...byConversation.keys()])].sort();
  const errors: PresentationError[] = [];
  const existing = db.query<Existing, [string]>(
    "SELECT snapshot_sha256, rule_version, source_record_max_rowid FROM codex_session_presentation WHERE session_id=?",
  );
  const conversationRows = db.query<ConversationRow, [string]>(
    `SELECT r.session_id, r.uuid, r.raw, r.payload_state, r.rowid
     FROM records r JOIN sources s ON s.id=r.source_id
     WHERE s.kind='codex/conversation' AND r.session_id=?`,
  );
  const putSession = db.query(`INSERT INTO codex_session_presentation
    (session_id,category,display_title,parent_thread_id,agent_path,agent_nickname,agent_role,detail,snapshot_sha256,rule_version,source_record_max_rowid)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
    category=excluded.category, display_title=excluded.display_title, parent_thread_id=excluded.parent_thread_id,
    agent_path=excluded.agent_path, agent_nickname=excluded.agent_nickname, agent_role=excluded.agent_role,
    detail=excluded.detail, snapshot_sha256=excluded.snapshot_sha256, rule_version=excluded.rule_version,
    source_record_max_rowid=excluded.source_record_max_rowid`);
  const deleteItems = db.query("DELETE FROM codex_item_presentation WHERE session_id=?");
  const putItem = db.query("INSERT INTO codex_item_presentation (session_id,uuid,encrypted_block_indexes,rule_version) VALUES (?,?,?,?)");
  for (const sessionId of sessions) {
    const originals = bySession.get(sessionId) ?? [];
    const representative = [...originals].sort((a, b) => b.bytes - a.bytes || a.hash.localeCompare(b.hash))[0];
    const maxRowid = Math.max(0, ...originals.map((s) => s.maxRowid), byConversation.get(sessionId) ?? 0);
    const current = existing.get(sessionId);
    if (current?.rule_version === VERSION && current.source_record_max_rowid === maxRowid && current.snapshot_sha256 === (representative?.hash ?? null)) continue;
    try {
      db.transaction(() => {
        const converted = conversationRows.all(sessionId);
        const repRows = representative === undefined ? [] : loadRows(db, representative.sourceId, restore).map(parse);
        const classification = classifyCodexSource(obj(repRows[0])?.type === "session_meta" ? obj(obj(repRows[0])?.payload)?.source : null);
        const title = representative === undefined
          ? db.query<{ title: string | null }, [string]>("SELECT title FROM session_summaries WHERE provider='codex' AND session_id=?").get(sessionId)?.title ?? sessionId
          : codexDisplayTitle(sessionId, repRows);
        const available = new Map<string, Set<string>>();
        for (const row of converted) {
          if (row.uuid === null) continue;
          const content = comparableContent(parse(restore(row.raw, row.payload_state)));
          if (content === null) continue;
          const set = available.get(row.uuid) ?? new Set<string>();
          set.add(content);
          available.set(row.uuid, set);
        }
        const masks = new Map<string, number[]>();
        const ambiguous = new Set<string>();
        for (const source of originals) {
          const rawLines = loadRows(db, source.sourceId, restore);
          const output = convertCodexLines(rawLines);
          if (output.sessionId !== sessionId) continue;
          for (const line of output.messages.split("\n")) {
            if (line === "") continue;
            const projected = parse(line), uuid = str(projected?.uuid), sourceLine = obj(projected?.openai)?.sourceLine;
            if (uuid === null || typeof sourceLine !== "number") continue;
            const original = parse(rawLines[sourceLine - 1] ?? "");
            const positions = encryptedBlockIndexes(obj(original?.payload));
            if (positions.length === 0) continue;
            const blocks = obj(projected?.message)?.content;
            if (!Array.isArray(blocks) || positions.some((index) => obj(blocks[index])?.type !== "text" || obj(blocks[index])?.text !== PLACEHOLDER)) continue;
            const content = comparableContent(projected);
            if (content === null || !available.get(uuid)?.has(content)) continue;
            if (ambiguous.has(uuid)) continue;
            const prior = masks.get(uuid);
            if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(positions)) { masks.delete(uuid); ambiguous.add(uuid); continue; }
            masks.set(uuid, positions);
          }
        }
        putSession.run(sessionId, classification.category, title, classification.parent_thread_id, classification.agent_path,
          classification.agent_nickname, classification.agent_role, classification.detail, representative?.hash ?? null, VERSION, maxRowid);
        deleteItems.run(sessionId);
        for (const [uuid, indexes] of masks) putItem.run(sessionId, uuid, JSON.stringify(indexes), VERSION);
      }).immediate();
    } catch (error) {
      errors.push({ path: `codex/session/${sessionId}`, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors;
};
