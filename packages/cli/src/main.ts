#!/usr/bin/env bun
// The `artifacts` command (design.md section 9). Bun runs this file from a checkout; put it on PATH with a symbolic
// link. The release binaries are this file compiled by `bun build --compile` (scripts/build.ts).
import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fetch: (input, init) => fetch(input, init),
});
