-- docs/adr/0033: Codex conversations share existing records and search tables.
DROP VIEW messages;
DROP VIEW session_messages;
DROP VIEW copied_records;
DROP VIEW record_text_source;
DROP VIEW record_tool_text_source;

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
WHERE s.kind IN ('claude-code/transcript', 'claude-cowork/transcript', 'claude-ai/conversation', 'codex/conversation') AND r.type IN ('user', 'assistant');

CREATE VIEW record_tool_text_source AS
SELECT r.rowid AS record_rowid,
       CASE WHEN json_valid(r.raw) AND json_type(r.raw, '$.message.content') = 'array' THEN (
         SELECT group_concat(
                  CASE b.value ->> '$.type'
                    WHEN 'tool_use' THEN concat(b.value ->> '$.name', ' ', b.value ->> '$.input')
                    WHEN 'tool_result' THEN
                      CASE json_type(b.value, '$.content')
                        WHEN 'text' THEN b.value ->> '$.content'
                        WHEN 'array' THEN (
                          SELECT group_concat(c.value ->> '$.text', char(10) ORDER BY c.key)
                          FROM json_each(b.value, '$.content') AS c
                          WHERE CASE WHEN c.type = 'object'
                                     THEN c.value ->> '$.type' = 'text' AND json_type(c.value, '$.text') = 'text'
                                END
                        )
                      END
                  END,
                  char(10) ORDER BY b.key)
         FROM json_each(r.raw, '$.message.content') AS b
         WHERE CASE WHEN b.type = 'object' THEN b.value ->> '$.type' IN ('tool_use', 'tool_result') END
       ) END AS text
FROM records r JOIN sources s ON s.id = r.source_id
WHERE s.kind IN ('claude-code/transcript', 'claude-cowork/transcript', 'claude-ai/conversation', 'codex/conversation') AND r.type IN ('user', 'assistant');

CREATE VIEW copied_records AS
SELECT r.rowid AS record_rowid
FROM records r JOIN sources s ON s.id = r.source_id
WHERE r.uuid IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM records r2 JOIN sources s2 ON s2.id = r2.source_id
    WHERE r2.uuid = r.uuid AND r2.session_id IS r.session_id AND s2.provider = s.provider
      AND (s.provider <> 'codex' OR s2.kind = s.kind)
      AND (s2.path, s2.generation, r2.line_no) < (s.path, s.generation, r.line_no)
  );

CREATE VIEW session_messages AS
SELECT s.provider, r.session_id, r.rowid AS record_rowid, r.type, r.timestamp, r.raw, s.path, s.generation, r.line_no
FROM records r JOIN sources s ON s.id = r.source_id
WHERE s.kind IN ('claude-code/transcript', 'claude-cowork/transcript', 'claude-ai/conversation', 'codex/conversation') AND r.type IN ('user', 'assistant') AND r.session_id IS NOT NULL
  AND NOT (r.uuid IS NOT NULL AND EXISTS (
    SELECT 1 FROM records r2 JOIN sources s2 ON s2.id = r2.source_id
    WHERE r2.uuid = r.uuid AND r2.session_id IS r.session_id AND s2.provider = s.provider
      AND (s.provider <> 'codex' OR s2.kind = s.kind)
      AND (s2.path, s2.generation, r2.line_no) < (s.path, s.generation, r.line_no)
  ));

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
WHERE s.kind IN ('claude-code/transcript', 'claude-cowork/transcript', 'claude-ai/conversation', 'codex/conversation') AND r.type IN ('user', 'assistant');
