-- docs/adr/0021: full-text search over the tools of conversations, for chat-log search --tools.
-- Tool inputs (name and the JSON of input), string tool results, and the text parts of array tool
-- results; images and other parts of arrays are left out.

-- rowid is records.rowid
CREATE VIRTUAL TABLE record_tool_texts USING fts5(
  text,
  tokenize = 'trigram'
);

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
WHERE s.kind IN ('claude-code/transcript', 'claude-cowork/transcript', 'claude-ai/conversation') AND r.type IN ('user', 'assistant');

INSERT INTO record_tool_texts (rowid, text) SELECT record_rowid, text FROM record_tool_text_source WHERE text <> '';
