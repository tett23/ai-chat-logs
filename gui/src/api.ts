// Calls into the Rust commands of src-tauri/src/main.rs.
import { invoke } from "@tauri-apps/api/core";

export type StoreError =
  | { kind: "not_found"; path: string }
  | { kind: "old_schema"; found: number; required: number }
  | { kind: "sqlite"; message: string }
  | { kind: "settings"; message: string };

export type Status = { path: string | null; size: number | null; error: StoreError | null };

export type SessionSummary = {
  provider: string;
  session_id: string;
  cwd: string | null;
  title: string | null;
  first_at: string | null;
  last_at: string | null;
  message_count: number;
  category: string | null;
  parent_thread_id: string | null;
  agent_path: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  detail: string | null;
};

export type { Project } from "./projects.ts";
import type { Filter, Project } from "./projects.ts";

// full_length is the length before truncation, null when the body is whole (docs/adr/0005).
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; full_length: number | null }
  | { kind: "tool_use"; name: string; input: string; full_length: number | null }
  | { kind: "tool_result"; text: string; is_error: boolean; full_length: number | null }
  | { kind: "other"; label: string; json: string; full_length: number | null };

export type Message = {
  rowid: number;
  index: number;
  uuid: string | null;
  timestamp: string | null;
  role: string | null;
  model: string | null;
  is_sidechain: boolean;
  original_id: string | null;
  version: string | null;
  blocks: Block[];
  encrypted_block_indexes: number[];
};

export type SearchHit = {
  provider: string;
  session_id: string | null;
  index: number | null;
  uuid: string | null;
  timestamp: string | null;
  role: string | null;
  title: string | null;
  snippet: string;
  category: string | null;
  parent_thread_id: string | null;
  agent_path: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  detail: string | null;
};

export type SearchResult = { hits: SearchHit[]; total: number; slow: boolean };

export type Category = "normal" | "subagent" | "internal" | "all";

export const status = () => invoke<Status>("status");
export const listProjects = (category: Category) => invoke<Project[]>("list_projects", { category });
export const listSessions = (filter: Filter | null, category: Category, offset: number, limit: number) =>
  invoke<SessionSummary[]>("list_sessions", { provider: filter?.provider ?? null, cwd: filter?.cwd ?? null, cwdMissing: filter?.cwd_missing ?? false, category, offset, limit });
export const getSessionSummary = (provider: string, sessionId: string) => invoke<SessionSummary | null>("get_session_summary", { provider, sessionId });
// docs/adr/0014
export type MessagePage = { total: number; messages: Message[] };
export const getMessages = (provider: string, sessionId: string, from: number, limit: number) =>
  invoke<MessagePage>("get_messages", { provider, sessionId, from, limit });
export const getBlock = (rowid: number, index: number) => invoke<Block>("get_block", { rowid, index });
export const search = (query: string, filter: Filter | null, category: Category, offset: number, limit: number) =>
  invoke<SearchResult>("search", { query, provider: filter?.provider ?? null, cwd: filter?.cwd ?? null, cwdMissing: filter?.cwd_missing ?? false, category, offset, limit });

// docs/adr/0007: settings and setup
export type Origin = "environment" | "env_file" | "config_file" | "default";
export type Setting = { key: string; value: string | null; origin: Origin };
export type SettingsView = { config_path: string | null; settings: Setting[]; error: StoreError | null };

export type PathCheck = { key: string; path: string; kind: "file" | "directory" | "missing" };
export type LastRun = { started_at: string; finished_at: string | null; records_added: number; errors: string | null };
export type DatabaseCheck = {
  exists: boolean;
  schema_version: number | null;
  records: number | null;
  sessions: number | null;
  last_run: LastRun | null;
  error: string | null;
};
export type ToolCheck = { path: string | null; detail: string | null; error: string | null };
export type EnvironmentCheck = {
  paths: PathCheck[];
  database: DatabaseCheck;
  bun: ToolCheck;
  pm2: ToolCheck;
  pm2_registered: boolean | null;
  launch_agent: boolean;
};
export type RunResult = { exit_code: number | null; output: string };

export const getSettings = () => invoke<SettingsView>("get_settings");
export const saveSetting = (key: string, value: string | null) => invoke<SettingsView>("save_setting", { key, value });
export const checkEnvironment = () => invoke<EnvironmentCheck>("check_environment");
export const runSync = () => invoke<RunResult>("run_sync");
export const importClaudeAiExport = (zip: string) => invoke<RunResult>("import_claude_ai_export", { zip });
// docs/adr/0026: output is the destination on success, the tail of stderr otherwise.
export const exportSession = (provider: string, sessionId: string, path: string) => invoke<RunResult>("export_session", { provider, sessionId, path });

// docs/adr/0010
export type { ScanResult } from "./scan.ts";
import type { ScanResult } from "./scan.ts";
export const scanClaudeAiExports = () => invoke<ScanResult>("scan_claude_ai_exports");

