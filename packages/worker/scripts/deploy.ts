#!/usr/bin/env node
// Deploys the Worker with the deployment values that stay out of the repository (design.md section 11; DATA-2). Node
// runs this file and strips its types. Workers Builds runs it as the deploy command, `node scripts/deploy.ts`, with the
// values in the build variable ARTIFACTS_DEPLOY_JSONC; on the owner's machine, the same command reads the gitignored
// wrangler.deploy.jsonc instead. It takes no arguments. See deploy-run.ts for the steps and docs/operations.md for use.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deploy } from "./deploy-run.ts";
import { createRunner, onTerminationSignal } from "./runner.ts";

const workerDir = join(dirname(fileURLToPath(import.meta.url)), "..");

process.exitCode = await deploy({
  workerDir,
  env: process.env,
  args: process.argv.slice(2),
  // Workers Builds stops a build after 20 minutes; one wrangler command gets at most 10.
  run: createRunner({
    command: join(workerDir, "node_modules", ".bin", "wrangler"),
    cwd: workerDir,
    timeoutMs: 10 * 60 * 1000,
    graceMs: 10 * 1000,
  }),
  log: (line) => process.stderr.write(`${line}\n`),
  onSignal: onTerminationSignal,
});
