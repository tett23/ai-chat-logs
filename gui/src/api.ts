// Calls into the Rust commands of src-tauri/src/main.rs.
import { invoke } from "@tauri-apps/api/core";

export type StoreError =
  | { kind: "not_found"; path: string }
  | { kind: "old_schema"; found: number; required: number }
  | { kind: "sqlite"; message: string };

export type Status = { path: string | null; error: StoreError | null };

export type SessionSummary = {
  provider: string;
  session_id: string;
  cwd: string | null;
  title: string | null;
  first_at: string | null;
  last_at: string | null;
  message_count: number;
};

export type Project = { cwd: string | null; session_count: number };

// full_length is the length before truncation, null when the body is whole (docs/adr/0005).
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; full_length: number | null }
  | { kind: "tool_use"; name: string; input: string; full_length: number | null }
  | { kind: "tool_result"; text: string; is_error: boolean; full_length: number | null }
  | { kind: "other"; label: string; json: string; full_length: number | null };

export type Message = {
  rowid: number;
  uuid: string | null;
  timestamp: string | null;
  role: string | null;
  model: string | null;
  is_sidechain: boolean;
  blocks: Block[];
};

export type SearchHit = {
  provider: string;
  session_id: string | null;
  uuid: string | null;
  timestamp: string | null;
  role: string | null;
  title: string | null;
  snippet: string;
};

export type SearchResult = { hits: SearchHit[]; slow: boolean };

export const status = () => invoke<Status>("status");
export const listProjects = () => invoke<Project[]>("list_projects");
export const listSessions = (cwd: string | null, offset: number, limit: number) =>
  invoke<SessionSummary[]>("list_sessions", { cwd, offset, limit });
export const getSession = (sessionId: string) => invoke<Message[]>("get_session", { sessionId });
export const getBlock = (rowid: number, index: number) => invoke<Block>("get_block", { rowid, index });
export const search = (query: string, cwd: string | null, offset: number, limit: number) =>
  invoke<SearchResult>("search", { query, cwd, offset, limit });
