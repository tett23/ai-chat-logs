-- docs/adr/0006: conversations of Cowork and claude.ai, and session titles of Cowork.
-- "Conversation kinds" are claude-code/transcript, claude-cowork/transcript and claude-ai/conversation.

DROP VIEW messages;
DROP VIEW session_summary_source;
DROP VIEW session_messages;
DROP VIEW record_text_source;

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
WHERE s.kind IN ('claude-code/transcript', 'claude-cowork/transcript', 'claude-ai/conversation') AND r.type IN ('user', 'assistant');

CREATE VIEW session_messages AS
SELECT s.provider, r.session_id, r.rowid AS record_rowid, r.type, r.timestamp, r.raw, s.path, s.generation, r.line_no
FROM records r JOIN sources s ON s.id = r.source_id
WHERE s.kind IN ('claude-code/transcript', 'claude-cowork/transcript', 'claude-ai/conversation') AND r.type IN ('user', 'assistant') AND r.session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM copied_records c WHERE c.record_rowid = r.rowid);

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
         -- 2. the title in the latest version of the provider's session file pointing at this session
         (SELECT CAST(b.content AS TEXT) ->> '$.title'
            FROM file_versions v
            JOIN sources s ON s.id = v.source_id
            JOIN blobs b ON b.sha256 = v.sha256
           WHERE s.kind = CASE m.provider
                            WHEN 'claude-code' THEN 'claude-desktop/session'
                            WHEN 'claude-cowork' THEN 'claude-cowork/session'
                          END
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
WHERE s.kind IN ('claude-code/transcript', 'claude-cowork/transcript', 'claude-ai/conversation') AND r.type IN ('user', 'assistant');

INSERT INTO record_texts (rowid, text)
SELECT record_rowid, text FROM record_text_source
WHERE text <> '' AND record_rowid NOT IN (SELECT rowid FROM record_texts);

DELETE FROM session_summaries;
INSERT INTO session_summaries SELECT * FROM session_summary_source;
