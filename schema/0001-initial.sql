-- docs/adr/0001
CREATE TABLE sources (
  id             INTEGER PRIMARY KEY,
  kind           TEXT    NOT NULL,
  provider       TEXT GENERATED ALWAYS AS (substr(kind, 1, instr(kind, '/') - 1)) VIRTUAL,
  path           TEXT    NOT NULL,
  generation     INTEGER NOT NULL DEFAULT 0,
  consumed_bytes INTEGER NOT NULL DEFAULT 0,
  consumed_lines INTEGER NOT NULL DEFAULT 0,
  head_sha256    TEXT,
  size           INTEGER,
  mtime_ms       INTEGER,
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL,
  missing_since  TEXT,
  UNIQUE (path, generation)
);
CREATE INDEX sources_provider ON sources (provider);

CREATE TABLE records (
  source_id   INTEGER NOT NULL REFERENCES sources(id),
  line_no     INTEGER NOT NULL,
  raw         TEXT    NOT NULL,
  imported_at TEXT    NOT NULL,
  -- filled by the per-kind extractor (src/extract.ts)
  type        TEXT,
  uuid        TEXT,
  session_id  TEXT,
  timestamp   TEXT,
  PRIMARY KEY (source_id, line_no)
);
CREATE INDEX records_session ON records (session_id, timestamp);
CREATE INDEX records_uuid    ON records (uuid);

CREATE TABLE blobs (
  sha256  TEXT PRIMARY KEY,
  size    INTEGER NOT NULL,
  content BLOB    NOT NULL
);

CREATE TABLE file_versions (
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  sha256        TEXT    NOT NULL REFERENCES blobs(sha256),
  first_seen_at TEXT    NOT NULL,
  PRIMARY KEY (source_id, sha256)
);

CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  sources_seen  INTEGER NOT NULL DEFAULT 0,
  records_added INTEGER NOT NULL DEFAULT 0,
  blobs_added   INTEGER NOT NULL DEFAULT 0,
  errors        TEXT
);

-- Add a UNION ALL branch with the same columns for each new provider.
CREATE VIEW messages AS
SELECT s.provider, r.session_id, r.uuid,
       r.raw ->> '$.parentUuid'     AS parent_uuid,
       r.type,
       r.timestamp,
       r.raw ->> '$.message.role'   AS role,
       r.raw ->> '$.message.model'  AS model,
       r.raw ->> '$.isSidechain'    AS is_sidechain,
       r.raw ->> '$.cwd'            AS cwd,
       r.raw -> '$.message.content' AS content,
       s.path                       AS source_path
FROM records r JOIN sources s ON s.id = r.source_id
WHERE s.kind = 'claude-code/transcript' AND r.type IN ('user', 'assistant');
