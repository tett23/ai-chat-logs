#!/usr/bin/env -S bun --no-env-file
// docs/adr/0034: store complete Codex rollout snapshots and their projections.
import { loadEnvFile } from "../env.ts";
import { codexDir, codexStore } from "../paths.ts";
import { convertCodexLogs } from "../codex-store.ts";

loadEnvFile();
try {
  const result = convertCodexLogs(codexDir(process.env), codexStore(process.env));
  result.directories.forEach((directory) => console.log(directory));
  result.errors.forEach((error) => console.error(`codex-log-convert: ${error}`));
  process.exitCode = result.status;
} catch (error) {
  console.error(`codex-log-convert: ${String(error)}`);
  process.exitCode = 1;
}
