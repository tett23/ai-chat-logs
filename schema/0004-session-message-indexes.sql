-- docs/adr/0017: number session messages from indexes alone, without reading records' rows
-- (type and uuid come after raw, so reading them follows raw's overflow pages).

CREATE INDEX records_session_order ON records (session_id, type, timestamp, uuid, source_id, line_no);
CREATE INDEX records_uuid_session  ON records (uuid, session_id, source_id, line_no);
DROP INDEX records_uuid;

-- The same rows as before: the copy rule of copied_records, written against r and s so that
-- the indexes above cover it.
DROP VIEW session_messages;
CREATE VIEW session_messages AS
SELECT s.provider, r.session_id, r.rowid AS record_rowid, r.type, r.timestamp, r.raw, s.path, s.generation, r.line_no
FROM records r JOIN sources s ON s.id = r.source_id
WHERE s.kind IN ('claude-code/transcript', 'claude-cowork/transcript', 'claude-ai/conversation') AND r.type IN ('user', 'assistant') AND r.session_id IS NOT NULL
  AND NOT (r.uuid IS NOT NULL AND EXISTS (
    SELECT 1 FROM records r2 JOIN sources s2 ON s2.id = r2.source_id
    WHERE r2.uuid = r.uuid AND r2.session_id IS r.session_id AND s2.provider = s.provider
      AND (s2.path, s2.generation, r2.line_no) < (s.path, s.generation, r.line_no)
  ));
