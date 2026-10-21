// docs/adr/0011: option values of chat-log.

const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

// "7d", "12h", "30m", or an ISO 8601 date or time; returns an ISO 8601 time in UTC.
export const parseSince = (input: string, now: number = Date.now()): string => {
  const relative = /^(\d+)([dhm])$/.exec(input);
  if (relative) return new Date(now - Number(relative[1]) * (UNITS[relative[2] as string] as number)).toISOString();
  const time = /^\d{4}-\d{2}-\d{2}/.test(input) ? Date.parse(input) : Number.NaN;
  if (Number.isNaN(time)) throw new Error(`時刻の形が正しくありません: ${input}（例：2026-10-01、7d、12h、30m）`);
  return new Date(time).toISOString();
};

export type SessionMatch = { kind: "found"; id: string } | { kind: "ambiguous"; ids: string[] } | { kind: "none" } | { kind: "short" };

export const MIN_PREFIX = 8;

// A session ID or a unique prefix of at least 8 characters, like a short git hash.
export const matchSession = (prefix: string, ids: readonly string[]): SessionMatch => {
  if (prefix.length < MIN_PREFIX) return { kind: "short" };
  if (ids.includes(prefix)) return { kind: "found", id: prefix };
  const candidates = ids.filter((id) => id.startsWith(prefix)).toSorted();
  if (candidates.length === 0) return { kind: "none" };
  return candidates.length === 1 ? { kind: "found", id: candidates[0] as string } : { kind: "ambiguous", ids: candidates };
};
