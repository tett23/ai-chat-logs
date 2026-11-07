-- docs/adr/0031: large strings of records.raw that SQL does not read, kept once each by the SHA-256
-- of their JSON string literal (the bytes between and including the quotes, escapes as they were).
-- raw holds the marker literal "\u0000ai-chat-logs-payload:<sha256>" in their place.

CREATE TABLE payloads (
  sha256   TEXT    PRIMARY KEY,
  size     INTEGER NOT NULL,  -- bytes of the literal
  encoding TEXT    NOT NULL CHECK (encoding IN ('zstd', 'base64')),
  content  BLOB    NOT NULL   -- zstd: the literal compressed; base64: the decoded bytes
);

-- NULL: not processed yet, 0: nothing taken out, 1: raw holds markers
ALTER TABLE records ADD COLUMN payload_state INTEGER;
