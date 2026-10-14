import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const tempDir = (): string => mkdtempSync(join(tmpdir(), "ai-chat-logs-test-"));

export const writeFile = (path: string, content: string | Uint8Array): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};

export const jsonl = (...records: unknown[]): string =>
  records.map((r) => `${JSON.stringify(r)}\n`).join("");

export const repoRoot = join(import.meta.dir, "..");
