-- docs/adr/0003, docs/adr/0005: full-text search over conversation text and session summaries.
-- The rules live in the views below so that incremental imports and this migration share them.
-- Add a UNION ALL branch to each view for each new provider.

-- rowid is records.rowid
CREATE VIRTUAL TABLE record_texts USING fts5(
  text,
  tokenize = 'trigram'
);

CREATE TABLE session_summaries (
  provider      TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  cwd           TEXT,
  title         TEXT,
  first_at      TEXT,
  last_at       TEXT,
  message_count INTEGER NOT NULL,
  PRIMARY KEY (provider, session_id)
);
CREATE INDEX session_summaries_last_at ON session_summaries (last_at);
CREATE INDEX session_summaries_cwd ON session_summaries (cwd, last_at);

-- Text of user and assistant records: a string content, or the text and thinking blocks joined by newlines.
CREATE VIEW record_text_source AS
SELECT r.rowid AS record_rowid,
       CASE WHEN json_valid(r.raw) THEN
         CASE json_type(r.raw, '$.message.content')
           WHEN 'text' THEN r.raw ->> '$.message.content'
           WHEN 'array' THEN (
             SELECT group_concat(
                      CASE WHEN b.type = 'object' THEN b.value ->> ('$.' || (b.value ->> '$.type')) END,
                      char(10) ORDER BY b.key)
             FROM json_each(r.raw, '$.message.content') AS b
             WHERE CASE WHEN b.type = 'object'
                        THEN b.value ->> '$.type' IN ('text', 'thinking')
                             AND json_type(b.value, '$.' || (b.value ->> '$.type')) = 'text'
                   END
           )
         END
       END AS text
FROM records r JOIN sources s ON s.id = r.source_id
WHERE s.kind = 'claude-code/transcript' AND r.type IN ('user', 'assistant');

-- Messages of sessions, the rows a summary is made of.
CREATE VIEW session_messages AS
SELECT s.provider, r.session_id, r.rowid AS record_rowid, r.type, r.timestamp, r.raw, s.path, s.generation, r.line_no
FROM records r JOIN sources s ON s.id = r.source_id
WHERE s.kind = 'claude-code/transcript' AND r.type IN ('user', 'assistant') AND r.session_id IS NOT NULL;

CREATE VIEW session_summary_source AS
SELECT m.provider,
       m.session_id,
       (SELECT m2.raw ->> '$.cwd' FROM session_messages m2
         WHERE m2.provider = m.provider AND m2.session_id = m.session_id AND m2.raw ->> '$.cwd' IS NOT NULL
         ORDER BY m2.timestamp, m2.path, m2.generation, m2.line_no LIMIT 1) AS cwd,
       COALESCE(
         -- 1. the last custom title in file order
         (SELECT r.raw ->> '$.customTitle' FROM records r JOIN sources s ON s.id = r.source_id
           WHERE s.provider = m.provider AND r.session_id = m.session_id AND r.type = 'custom-title'
             AND r.raw ->> '$.customTitle' IS NOT NULL
           ORDER BY s.path DESC, s.generation DESC, r.line_no DESC LIMIT 1),
         -- 2. the title in the latest version of a desktop app session pointing at this session
         (SELECT CAST(b.content AS TEXT) ->> '$.title'
            FROM file_versions v
            JOIN sources s ON s.id = v.source_id
            JOIN blobs b ON b.sha256 = v.sha256
           WHERE m.provider = 'claude-code' AND s.kind = 'claude-desktop/session'
             AND v.rowid = (SELECT max(v2.rowid) FROM file_versions v2 WHERE v2.source_id = v.source_id)
             AND CASE WHEN json_valid(CAST(b.content AS TEXT))
                      THEN CAST(b.content AS TEXT) ->> '$.cliSessionId' = m.session_id END
           ORDER BY v.rowid DESC LIMIT 1),
         -- 3. the first 80 characters of the first non-meta user text
         (SELECT substr(t.text, 1, 80) FROM session_messages m3
            JOIN record_text_source t ON t.record_rowid = m3.record_rowid
           WHERE m3.provider = m.provider AND m3.session_id = m.session_id AND m3.type = 'user'
             AND coalesce(m3.raw ->> '$.isMeta', 0) = 0 AND t.text <> ''
           ORDER BY m3.timestamp, m3.path, m3.generation, m3.line_no LIMIT 1)
       ) AS title,
       min(m.timestamp) AS first_at,
       max(m.timestamp) AS last_at,
       count(*) AS message_count
FROM session_messages m
GROUP BY m.provider, m.session_id;

INSERT INTO record_texts (rowid, text) SELECT record_rowid, text FROM record_text_source WHERE text <> '';
INSERT INTO session_summaries SELECT * FROM session_summary_source;
