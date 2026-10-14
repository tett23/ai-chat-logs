#!/usr/bin/env bun
// docs/adr/0001: print "<kind>\t<absolute path>" for each source.
import { listSources } from "../sources.ts";

process.stdout.write(listSources(process.env).map(({ kind, path }) => `${kind}\t${path}\n`).join(""));
