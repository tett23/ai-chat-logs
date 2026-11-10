-- docs/adr/0037: additive, reproducible GUI presentation data for Codex.
CREATE TABLE codex_session_presentation (
  session_id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('normal', 'subagent', 'internal', 'unknown')),
  display_title TEXT NOT NULL,
  parent_thread_id TEXT,
  agent_path TEXT,
  agent_nickname TEXT,
  agent_role TEXT,
  detail TEXT,
  snapshot_sha256 TEXT,
  rule_version INTEGER NOT NULL,
  source_record_max_rowid INTEGER NOT NULL
);

CREATE TABLE codex_item_presentation (
  session_id TEXT NOT NULL REFERENCES codex_session_presentation(session_id) ON DELETE CASCADE,
  uuid TEXT NOT NULL,
  encrypted_block_indexes TEXT NOT NULL CHECK (json_valid(encrypted_block_indexes)),
  rule_version INTEGER NOT NULL,
  PRIMARY KEY (session_id, uuid)
);
