// docs/adr/0006, docs/adr/0010: keep a claude.ai export and its converted messages.jsonl under the claude.ai directory.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertConversations, exportId } from "./claude-ai.ts";

export const EXPORT_FILES = ["conversations.json", "projects.json", "users.json"] as const;
export type ExportFile = (typeof EXPORT_FILES)[number];

// Where an export with this conversations.json is (or would be) kept.
export const exportDir = (root: string, conversations: Uint8Array): string => join(root, exportId(conversations));

export const isStored = (root: string, conversations: Uint8Array): boolean =>
  existsSync(join(exportDir(root, conversations), "messages.jsonl"));

const writeAtomically = (path: string, content: string | Uint8Array): void => {
  const partial = `${path}.tmp`;
  writeFileSync(partial, content);
  renameSync(partial, path);
};

// Converts and stores an export; files already present are kept as they are. Throws on an invalid conversations.json
// before writing anything. Returns the directory.
export const storeExport = (root: string, files: Partial<Record<ExportFile, Uint8Array>> & { "conversations.json": Uint8Array }): string => {
  const lines = convertConversations(JSON.parse(new TextDecoder().decode(files["conversations.json"])));
  const out = exportDir(root, files["conversations.json"]);
  mkdirSync(out, { recursive: true });
  EXPORT_FILES.forEach((name) => {
    const content = files[name];
    if (content !== undefined && !existsSync(join(out, name))) writeAtomically(join(out, name), content);
  });
  const messages = join(out, "messages.jsonl");
  if (!existsSync(messages)) writeAtomically(messages, lines.map((l) => `${l}\n`).join(""));
  return out;
};
