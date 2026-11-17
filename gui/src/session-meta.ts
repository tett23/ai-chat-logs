// docs/adr/0040: the summary of a session in the sidebar, at most two lines.
type Meta = {
  session_id: string;
  title: string | null;
  cwd: string | null;
  first_at: string | null;
  last_at: string | null;
  message_count: number;
};

export const lastPathPart = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

// The second line: the last time, the count, the last part of cwd and the first 8 characters of the ID.
export const sidebarMeta = (s: Meta, time: (iso: string | null) => string): string =>
  [time(s.last_at), `${s.message_count} 件`, ...(s.cwd ? [lastPathPart(s.cwd)] : []), s.session_id.slice(0, 8)].join(" · ");

export const sessionTooltip = (s: Meta, time: (iso: string | null) => string): string =>
  [s.title ?? s.session_id, `セッションID: ${s.session_id}`, ...(s.cwd ? [`cwd: ${s.cwd}`] : []), `期間: ${time(s.first_at)} 〜 ${time(s.last_at)}`].join("\n");
