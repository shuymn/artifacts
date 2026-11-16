#!/usr/bin/env node
// Installs the workspace's dependencies with the pnpm version of mise.lock (docs/operations.md section 3). Node runs
// this file and strips its types. It runs before the dependencies exist, so it imports nothing but Node and this
// directory's install-run.ts and runner.ts. Workers Builds runs it as the build command, `node scripts/install.ts`; it
// works the same on the owner's machine. It takes no arguments. See install-run.ts for what it does.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { install } from "./install-run.ts";
import { createRunner, onTerminationSignal } from "./runner.ts";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

process.exitCode = await install({
  repoDir,
  env: process.env,
  args: process.argv.slice(2),
  nodeVersion: process.versions.node,
  // Workers Builds stops a build after 20 minutes; the install gets at most 10.
  run: createRunner({ command: "npx", cwd: repoDir, timeoutMs: 10 * 60 * 1000, graceMs: 10 * 1000 }),
  log: (line) => process.stderr.write(`${line}\n`),
  onSignal: onTerminationSignal,
});
