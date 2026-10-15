// docs/adr/0001, docs/adr/0006: "<provider>/<kind>"
export const LINE_KINDS = [
  "claude-code/transcript",
  "claude-code/history",
  "claude-cowork/transcript",
  "claude-cowork/audit",
  "claude-ai/conversation",
] as const;
export const FILE_KINDS = ["claude-code/file", "claude-desktop/session", "claude-cowork/file", "claude-cowork/session", "claude-ai/export"] as const;

export type LineKind = (typeof LINE_KINDS)[number];
export type FileKind = (typeof FILE_KINDS)[number];
export type Kind = LineKind | FileKind;

export const isLineKind = (kind: string): kind is LineKind => (LINE_KINDS as readonly string[]).includes(kind);
export const isFileKind = (kind: string): kind is FileKind => (FILE_KINDS as readonly string[]).includes(kind);
export const isKind = (kind: string): kind is Kind => isLineKind(kind) || isFileKind(kind);
