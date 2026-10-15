export const LINE_KINDS = ["claude-code/transcript", "claude-code/history"] as const;
export const FILE_KINDS = ["claude-code/file", "claude-desktop/session"] as const;

export type LineKind = (typeof LINE_KINDS)[number];
export type FileKind = (typeof FILE_KINDS)[number];
export type Kind = LineKind | FileKind;

export const isLineKind = (kind: string): kind is LineKind => (LINE_KINDS as readonly string[]).includes(kind);
export const isFileKind = (kind: string): kind is FileKind => (FILE_KINDS as readonly string[]).includes(kind);
export const isKind = (kind: string): kind is Kind => isLineKind(kind) || isFileKind(kind);
