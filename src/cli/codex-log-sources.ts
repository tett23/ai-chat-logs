#!/usr/bin/env -S bun --no-env-file
// docs/adr/0034, docs/adr/0041: list published Codex stores for chat-log-import.
import { loadEnvFile } from "../env.ts";
import { codexStore } from "../paths.ts";
import { scanCodexSources } from "../codex-store.ts";

loadEnvFile();
if (process.argv.length !== 2) {
  console.error("usage: codex-log-sources");
  process.exit(2);
}
try {
  const { sources, errors } = scanCodexSources(codexStore(process.env));
  process.stdout.write(sources.map(({ kind, path }) => `${kind}\t${path}\n`).join(""));
  // A broken store is left out and reported here; codex-log-convert fails on it, and the other stores are still imported.
  errors.forEach((error) => console.error(`codex-log-sources: ${error}`));
} catch (error) {
  console.error(`codex-log-sources: ${String(error)}`);
  process.exitCode = 1;
}
