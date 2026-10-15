import type { LineKind } from "./kinds.ts";

// docs/adr/0001: fields stored in records columns, extracted per kind so that other providers can be added.
export type Fields = {
  type: string | null;
  uuid: string | null;
  sessionId: string | null;
  timestamp: string | null;
};

type JsonObject = Record<string, unknown>;

const EMPTY: Fields = { type: null, uuid: null, sessionId: null, timestamp: null };

const parseObject = (raw: string): JsonObject | null => {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
  } catch {
    return null;
  }
};

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const epochMsToIso = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const transcript = (r: JsonObject): Fields => ({
  type: str(r.type),
  uuid: str(r.uuid),
  sessionId: str(r.sessionId),
  timestamp: str(r.timestamp),
});

const EXTRACTORS: Record<LineKind, (record: JsonObject) => Fields> = {
  "claude-code/transcript": transcript,
  "claude-cowork/transcript": transcript,
  "claude-ai/conversation": transcript,
  "claude-cowork/audit": (r) => ({
    type: str(r.type),
    uuid: str(r.uuid),
    sessionId: str(r.session_id),
    timestamp: str(r._audit_timestamp),
  }),
  "claude-code/history": (r) => ({
    type: null,
    uuid: null,
    sessionId: str(r.sessionId),
    timestamp: epochMsToIso(r.timestamp),
  }),
};

export const extractFields = (kind: LineKind, raw: string): Fields => {
  const record = parseObject(raw);
  return record ? EXTRACTORS[kind](record) : EMPTY;
};
