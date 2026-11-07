import type { Database } from "bun:sqlite";

// docs/adr/0031: take large strings that SQL does not read out of records.raw into payloads, kept
// once each, and put them back byte for byte. Markers replace the string literals as text, so a
// record restores to exactly the line it was imported from.

export const PAYLOAD_MIN_BYTES = 1024;
export type Encoding = "zstd" | "base64";
export type Payload = { sha256: string; size: number; encoding: Encoding; content: Uint8Array };
export type StoredPayload = Pick<Payload, "encoding" | "content">;

const MARKER_TEXT = "\\u0000ai-chat-logs-payload:";
const MARKER = /"\\u0000ai-chat-logs-payload:([0-9a-f]{64})"/g;
const markerOf = (sha256: string): string => `"${MARKER_TEXT}${sha256}"`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha256Of = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

type Segment = string | number;
type Span = { start: number; end: number; path: readonly Segment[] };

// The end (exclusive) of the string literal that starts with the quote at `start`.
const literalEnd = (text: string, start: number): number => {
  let from = start + 1;
  for (;;) {
    const q = text.indexOf('"', from);
    if (q < 0) return text.length;
    let backslashes = 0;
    while (text.charCodeAt(q - 1 - backslashes) === 92) backslashes++;
    if (backslashes % 2 === 0) return q + 1;
    from = q + 1;
  }
};

type Frame = { kind: "object"; key: string | null; expectKey: boolean } | { kind: "array"; index: number };

// The string values of a valid JSON text with their paths, keys excluded. Only literals of at least
// `minChars` UTF-16 code units are returned (a literal of n bytes has at least n / 3 code units).
const stringValues = (text: string, minChars: number): Span[] => {
  const spans: Span[] = [];
  const stack: Frame[] = [];
  const pathOf = (): Segment[] => stack.map((f) => (f.kind === "object" ? (f.key as string) : f.index));
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (c === "{") {
      stack.push({ kind: "object", key: null, expectKey: true });
      i++;
    } else if (c === "[") {
      stack.push({ kind: "array", index: 0 });
      i++;
    } else if (c === "}" || c === "]") {
      stack.pop();
      i++;
    } else if (c === ",") {
      if (top?.kind === "array") top.index++;
      else if (top?.kind === "object") top.expectKey = true;
      i++;
    } else if (c === ":") {
      if (top?.kind === "object") top.expectKey = false;
      i++;
    } else if (c === '"') {
      const end = literalEnd(text, i);
      if (top?.kind === "object" && top.expectKey) top.key = JSON.parse(text.slice(i, end)) as string;
      else if (end - i >= minChars) spans.push({ start: i, end, path: pathOf() });
      i = end;
    } else {
      i++;
    }
  }
  return spans;
};

// docs/adr/0031: the places SQL reads stay in raw: top-level members, members of message, and the
// type, text and thinking of content blocks (record_text_source reads $.<type> of text and thinking
// blocks). Other members of blocks, such as the content of tool_result, are taken out.
const BLOCK_MEMBERS_READ_BY_SQL: ReadonlySet<Segment> = new Set(["type", "text", "thinking"]);
const readBySql = (path: readonly Segment[]): boolean =>
  (path.length === 1 && typeof path[0] === "string") ||
  (path.length === 2 && path[0] === "message" && typeof path[1] === "string") ||
  (path.length === 4 && path[0] === "message" && path[1] === "content" && typeof path[2] === "number" && BLOCK_MEMBERS_READ_BY_SQL.has(path[3] as Segment));

const BASE64_LITERAL = /^"([A-Za-z0-9+/]+={0,2})"$/;

const payloadOf = (literal: string, bytes: Uint8Array): Payload => {
  const sha256 = sha256Of(bytes);
  const b64 = BASE64_LITERAL.exec(literal)?.[1];
  if (b64 !== undefined && b64.length % 4 === 0) {
    const decoded = Buffer.from(b64, "base64");
    if (decoded.toString("base64") === b64) return { sha256, size: bytes.length, encoding: "base64", content: new Uint8Array(decoded) };
  }
  return { sha256, size: bytes.length, encoding: "zstd", content: Bun.zstdCompressSync(bytes, { level: 3 }) };
};

export const literalOf = ({ encoding, content }: StoredPayload): string =>
  encoding === "base64" ? `"${Buffer.from(content).toString("base64")}"` : decoder.decode(Bun.zstdDecompressSync(content));

export const restorePayloads = (raw: string, lookup: (sha256: string) => StoredPayload | null): string =>
  raw.replace(MARKER, (_, sha256: string) => {
    const payload = lookup(sha256);
    if (payload === null) throw new Error(`payload not found: ${sha256}`);
    return literalOf(payload);
  });

const isJson = (raw: string): boolean => {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
};

// The record with its payloads taken out, or null when nothing is taken out.
export const takePayloads = (raw: string): { raw: string; payloads: Payload[] } | null => {
  if (raw.length < PAYLOAD_MIN_BYTES / 3 || raw.includes(MARKER_TEXT) || !isJson(raw)) return null;
  const spans = stringValues(raw, Math.ceil(PAYLOAD_MIN_BYTES / 3))
    .filter((s) => !readBySql(s.path))
    .map((s) => ({ ...s, bytes: encoder.encode(raw.slice(s.start, s.end)) }))
    .filter((s) => s.bytes.length >= PAYLOAD_MIN_BYTES);
  if (spans.length === 0) return null;
  const taken = spans.map((s) => ({ ...s, payload: payloadOf(raw.slice(s.start, s.end), s.bytes) }));
  const stripped = taken.reduceRight((text, s) => text.slice(0, s.start) + markerOf(s.payload.sha256) + text.slice(s.end), raw);
  const payloads = [...new Map(taken.map((s) => [s.payload.sha256, s.payload])).values()];
  const byHash = new Map(payloads.map((p) => [p.sha256, p]));
  // Keep a record as it is unless it restores exactly.
  return restorePayloads(stripped, (sha) => byHash.get(sha) ?? null) === raw ? { raw: stripped, payloads } : null;
};

type Row = { rowid: number; raw: string };

const storeRows = (db: Database, rows: readonly Row[]): void => {
  const insert = db.query("INSERT OR IGNORE INTO payloads (sha256, size, encoding, content) VALUES (?, ?, ?, ?)");
  const update = db.query("UPDATE records SET raw = ?, payload_state = ? WHERE rowid = ?");
  const mark = db.query("UPDATE records SET payload_state = 0 WHERE rowid = ?");
  rows.forEach(({ rowid, raw }) => {
    const taken = takePayloads(raw);
    if (taken === null) {
      mark.run(rowid);
      return;
    }
    taken.payloads.forEach((p) => {
      insert.run(p.sha256, p.size, p.encoding, p.content);
    });
    update.run(taken.raw, 1, rowid);
  });
};

// Take payloads out of the records after `rowid` that are not processed yet. Called inside the
// import's transaction, after the search texts and summaries are built from the whole lines.
export const takePayloadsAfter = (db: Database, rowid: number): void =>
  storeRows(db, db.query<Row, [number]>("SELECT rowid, raw FROM records WHERE rowid > ? AND payload_state IS NULL").all(rowid));

// Convert every record not processed yet, `batch` records per transaction; returns how many.
export const convertPendingPayloads = (db: Database, batch = 10_000): number => {
  const select = db.query<Row, [number, number]>("SELECT rowid, raw FROM records WHERE rowid > ? AND payload_state IS NULL ORDER BY rowid LIMIT ?");
  const step = (after: number, done: number): number => {
    const rows = db.transaction(() => {
      const found = select.all(after, batch);
      storeRows(db, found);
      return found;
    }).immediate();
    const last = rows[rows.length - 1];
    return last === undefined ? done : step(last.rowid, done + rows.length);
  };
  return step(0, 0);
};

// A function that restores raw of a record of `db`, given its payload_state.
export const restoredRaw = (db: Database): ((raw: string, state: number | null) => string) => {
  const select = db.query<StoredPayload, [string]>("SELECT encoding, content FROM payloads WHERE sha256 = ?");
  return (raw, state) => (state === 1 ? restorePayloads(raw, (sha) => select.get(sha)) : raw);
};
