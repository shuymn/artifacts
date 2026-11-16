#!/usr/bin/env node
// The `artifacts` command (design.md section 9). Node runs this file from a checkout and strips its types; put it on
// PATH with a symbolic link.
import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fetch: (input, init) => fetch(input, init),
});
