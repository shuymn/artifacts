// Creates the repository's GitHub App with the manifest flow and stores its credentials for the workflows.
//
// The mise update workflow (.github/workflows/mise-update.yml) opens its pull requests with a GitHub App token, read
// from the `APP_CLIENT_ID` variable and the `APP_PRIVATE_KEY` secret. This script:
//   1. serves a page on 127.0.0.1 that posts the App manifest (Contents and Pull requests write, no webhook) to GitHub;
//   2. receives GitHub's redirect after "Create GitHub App" and exchanges the one-time code for the App's credentials;
//   3. sets `APP_CLIENT_ID` and `APP_PRIVATE_KEY` on the repository with `gh` (the key goes through stdin only, and is
//      never printed or written to disk);
//   4. redirects to the App's installation page, where "Only select repositories" picks this repository.
//
// Usage: pnpm run github-app [--name <app-name>]. Requires `gh` signed in as the repository's owner. The default name
// is `<repo>-automation-<owner>`; App names are global on GitHub and at most 34 characters.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const TIMEOUT_MS = 10 * 60 * 1000;
const GH_TIMEOUT_MS = 60 * 1000;
const PERMISSIONS = { contents: "write", pull_requests: "write" };

function fail(message) {
  console.error(`github-app: ${message}`);
  process.exit(1);
}

// gh's HTTP debugging (GH_DEBUG=api) would print the conversion response, private key included, so it is turned off.
const { GH_DEBUG: _ghDebug, DEBUG: _debug, ...GH_ENV } = process.env;

function gh(args, input) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: GH_ENV,
    input,
    stdio: ["pipe", "pipe", "inherit"],
    timeout: GH_TIMEOUT_MS,
  });
  if (result.status !== 0) fail(`gh ${args.slice(0, 2).join(" ")} failed`);
  return result.stdout;
}

function openInBrowser(url) {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
  console.log(`Open ${url} if the browser did not open.`);
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const { values } = parseArgs({ options: { name: { type: "string" } } });
const { nameWithOwner } = JSON.parse(gh(["repo", "view", "--json", "nameWithOwner"]));
const repo = JSON.parse(gh(["api", `repos/${nameWithOwner}`]));
if (repo.owner.type !== "User")
  fail("the manifest flow here creates a user-owned App; the repository owner is not a user");
const name = values.name ?? `${repo.name}-automation-${repo.owner.login}`;
if (name.length > 34) fail(`the App name "${name}" is longer than 34 characters; pass --name`);

const state = randomBytes(16).toString("hex");
let done = false;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/" && !done) {
    const manifest = {
      name,
      url: repo.html_url,
      hook_attributes: { url: repo.html_url, active: false },
      redirect_url: `http://127.0.0.1:${server.address().port}/callback`,
      public: false,
      default_permissions: PERMISSIONS,
      default_events: [],
    };
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Create GitHub App</title>
<form method="post" action="https://github.com/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<p>Creating the GitHub App <b>${escapeHtml(name)}</b> for ${escapeHtml(repo.owner.login)}/${escapeHtml(repo.name)}.</p>
<button type="submit">Continue to GitHub</button>
</form><script>document.forms[0].submit()</script>`);
    return;
  }
  if (url.pathname === "/callback" && !done) {
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || code === null || !/^[0-9a-f]+$/i.test(code)) {
      response.writeHead(400, { "content-type": "text/plain" }).end("Unexpected callback");
      return;
    }
    done = true;
    const app = JSON.parse(gh(["api", "-X", "POST", `app-manifests/${code}/conversions`]));
    const target = `${repo.owner.login}/${repo.name}`;
    console.log(`Created ${app.html_url}`);
    // The browser may be signed in to another account, which would own the App and could not be installed here.
    if (app.owner?.login !== repo.owner.login) {
      fail(
        `the App belongs to ${app.owner?.login}, not ${repo.owner.login}; delete it and run again signed in as the owner`,
      );
    }
    for (const [permission, access] of Object.entries(PERMISSIONS)) {
      if (app.permissions?.[permission] !== access)
        fail(`the App lacks ${permission}: ${access}; delete it and run again`);
    }
    // The secret goes first: if it fails, both values still name the previous App; if the variable then fails, rerunning
    // `gh variable set APP_CLIENT_ID` with the client ID below completes the pair.
    gh(["secret", "set", "APP_PRIVATE_KEY", "--repo", target], app.pem);
    console.log(`Set APP_PRIVATE_KEY on ${target}; the App's client ID is ${app.client_id}.`);
    gh(["variable", "set", "APP_CLIENT_ID", "--repo", target, "--body", app.client_id]);
    console.log(`Set APP_CLIENT_ID on ${target}.`);
    const install = `https://github.com/apps/${app.slug}/installations/new`;
    response.writeHead(302, { location: install }).end();
    console.log(`Install it with "Only select repositories" set to ${repo.name}: ${install}`);
    server.close();
    clearTimeout(timer);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
});

const timer = setTimeout(() => {
  server.close();
  fail("timed out waiting for GitHub's redirect");
}, TIMEOUT_MS);

server.listen(0, "127.0.0.1", () => openInBrowser(`http://127.0.0.1:${server.address().port}/`));
