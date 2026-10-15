#!/usr/bin/env -S bun --no-env-file
// docs/adr/0001: print "<kind>\t<absolute path>" for each source.
import { loadEnvFile } from "../env.ts";
import { listSources } from "../sources.ts";

loadEnvFile();

process.stdout.write(listSources(process.env).map(({ kind, path }) => `${kind}\t${path}\n`).join(""));
