#!/usr/bin/env -S bun --no-env-file
// docs/adr/0034: list published Codex snapshots for chat-log-import.
import { loadEnvFile } from "../env.ts";
import { codexStore } from "../paths.ts";
import { listCodexSources } from "../codex-store.ts";

loadEnvFile();
try {
  process.stdout.write(listCodexSources(codexStore(process.env)).map(({ kind, path }) => `${kind}\t${path}\n`).join(""));
} catch (error) {
  console.error(`codex-log-sources: ${String(error)}`);
  process.exitCode = 1;
}
