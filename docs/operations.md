# Operations

How the owner sets up, deploys, releases and checks a deployment of `artifacts`, and restores its metadata. The design
is in [design.md](design.md) (section 1 for hosts, section 11 for operations); the invariants named here (`ACC-2`,
`DATA-1` and so on) are in [threat-model.md](threat-model.md).

Values in angle brackets are placeholders, and the hosts below are the examples of design.md section 1:
`artifacts.example.com` (`APP_HOST`), `artifacts-api.example.com` (`API_HOST`), `-art.example.com`
(`CONTENT_HOST_SUFFIX`) and `-pub.example.com` (`PUBLIC_HOST_SUFFIX`) on one shared domain, or `-p.example-content.net`
and `-s.example-content.net` for content on its own registrable domain. `<team>` is the Zero Trust team name,
`<DATABASE_NAME>` the D1 database, `<BUCKET_NAME>` the R2 bucket, `<KV_NAME>` the KV namespace for OAuth. None of them
is written in this repository (P7).

**Planned (OAuth)** marks a step for OAuth sign-in (design.md section 7), which applies from the release that carries it
(design.md, "OAuth delivery"); until then a deployment uses API tokens only.

Commands run from `packages/worker`, with the tools mise installs from `mise.toml` and `.node-version`: there
`pnpm exec wrangler` is the Wrangler of the lockfile and `wrangler.jsonc` names the Worker. A block that starts elsewhere
says so. `artifacts` is the CLI, installed as in section 5. A claim about Cloudflare or another product links the page
that states it; **Unconfirmed** marks one the documentation does not state, and **Observed** one the documentation
does not state but a deployment of this repository showed.

## How a change reaches the deployment

```text
main ──(release-please keeps a release PR open)──> merge the release PR ──> tag vX.Y.Z and GitHub release
     ──(.github/workflows/release.yml fast-forwards)──> release ──(Workers Builds)──> scripts/deploy.ts
```

- `main` takes every change, dependency updates included, and is never deployed.
- release-please keeps one release PR open with the next version and the changelog, from the Conventional Commits on
  `main` (one version for the repository: the `node` release type on the root package, tags `vX.Y.Z`, first release
  `0.1.0`; `release-please-config.json`, `.release-please-manifest.json`). Merging it tags the release.
- Releases are immutable (`release_immutability` in `.github/infra.yaml`): once published, a release's tag cannot be
  moved or deleted, and deleting the release does not free its tag name
  ([immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).
  A bad release is fixed by the next one.
- The release workflow then fast-forwards the `release` branch to the latest release. It refuses a release that is not
  a commit of `main` and an update that is not a fast-forward: it updates the branch with `force=false`, which GitHub
  refuses unless the update is a fast-forward
  ([update a reference](https://docs.github.com/en/rest/git/refs#update-a-reference)). It runs on every push to `main`,
  so running it again, or the next push, repairs a run that failed.
- Workers Builds deploys each push to `release` and nothing else.

Both workflow steps use the repository's GitHub App token (`APP_CLIENT_ID`, `APP_PRIVATE_KEY`; `pnpm run github-app`
creates the App, see [README](../README.md)): a pull request opened with `GITHUB_TOKEN` starts no workflow, so the
release PR would never run the required checks. release-please creates its commits through the API without an author,
which GitHub signs for an App ([bot
signatures](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#signature-verification-for-bots)),
as `main`'s `required_signatures` rule needs. **Observed:** the first release PR's commits showed as verified; check it
again if the release workflow changes.

## 1. Cloudflare setup

Do this once, before the first deployment. Pick the layout of design.md section 1 first; the threat model's accepted
risks say what the shared-domain layout exposes.

- **Workers Paid.** The Worker runs on Workers Paid
  ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)), which also gives D1 Time Travel 30 days
  instead of 7 ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)).
- **Zones and certificates.** The domain (and, in the dedicated layout, the content domain) is a zone in the account
  with a full setup. Universal SSL then covers the apex and first-level subdomains only
  ([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)): every host here
  is first-level, which is why an artifact's label carries the suffix.
- **DNS.** Add a proxied wildcard record `*` in the zone that holds the artifact hosts (`example.com` or
  `example-content.net`); a route needs a proxied DNS record for the hosts it serves
  ([Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)). The Worker answers, so the record
  needs no origin: `AAAA` `*` `100::` is the placeholder for a setup without one ([originless
  setups](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/#originless-setups)). A
  wildcard applies only to names that have no record of their own, and it is multi-level ([wildcard
  records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)): on a shared
  domain, the owner's other hosts keep resolving as before.
- **Routes and Custom Domains** come from the deployment values (section 2) and are created by `wrangler deploy`. The
  app and API hosts are Custom Domains, for which Cloudflare creates the DNS record and certificate; a hostname that
  already has a `CNAME` record cannot become one ([Custom
  Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). The artifact hosts are
  routes: `*-art.example.com/*` and `*-pub.example.com/*`, or one `*.example-content.net/*`.
- **D1.** `pnpm exec wrangler d1 create <DATABASE_NAME> --update-config=false` prints the database ID
  ([get started](https://developers.cloudflare.com/d1/get-started/)). The deploy applies the migrations. Without
  `--update-config=false`, Wrangler offers to add the new binding to `wrangler.jsonc`, yes by default, which would put
  the identifiers in the repository (DATA-2); the same holds for the bucket.
- **R2.** `pnpm exec wrangler r2 bucket create <BUCKET_NAME> --update-config=false`: 3 to 63 characters of `a-z`, `0-9`
  and `-`
  ([create buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/)). A bucket is private until public
  access is turned on ([public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)); leave both the
  `r2.dev` URL and custom domains off. Create it before the first deploy: `wrangler deploy` creates a bucket that does
  not exist (the deploy script checks first, section 3).
- **KV** (Planned (OAuth)). `pnpm exec wrangler kv namespace create <KV_NAME> --update-config=false` prints the
  namespace ID ([get started](https://developers.cloudflare.com/kv/get-started/)). It holds OAuth clients, grants and
  hashed tokens, and nothing else; every record expires on its own. `--update-config=false` keeps the ID out of
  `wrangler.jsonc`, as for D1.

### Access

Two self-hosted applications in Zero Trust, each with an Allow policy that admits only the owner's identity; an
application denies everyone a policy does not allow ([self-hosted
application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)).

| Application | Public hostname                                                      | AUD goes to          |
| ----------- | -------------------------------------------------------------------- | -------------------- |
| app         | `artifacts.example.com`                                              | `ACCESS_APP_AUD`     |
| content     | `*-art.example.com`, or `*-p.example-content.net` (dedicated layout) | `ACCESS_CONTENT_AUD` |

- A wildcard at the start of the subdomain matches one level only
  ([application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)), so the
  content application covers exactly the artifact hosts. Neither application covers the API host or the public hosts.
- If an application already covers the whole zone (`*.example.com`, made for other services), give the API host and
  the public hosts (`*-pub.example.com`) a Bypass application each: MCP clients, the CLI and the OAuth endpoints carry
  no Access session, and a share link needs none. Bypass "disables any Access enforcement" for the traffic it matches,
  and its requests are not logged
  ([policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)).
  The documentation states precedence only for paths ("the more specific rule takes precedence", application paths
  above). **Observed:** in a deployment of this repository, Bypass applications on those hosts take precedence over a
  zone-wide application. Checks 3 and 9 of section 7 show it.
- In each application, **Advanced settings → Cookie settings**: turn on **HttpOnly**. On a protected domain the
  `CF_Authorization` cookie's HttpOnly flag is the administrator's choice ([authorization
  cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)),
  and without it artifact JavaScript could read a JWT that opens every private artifact (ACC-3).
- Each application's **Additional settings** show its **Application Audience (AUD) Tag** ([validate
  JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)).
  `ACCESS_TEAM_DOMAIN` is `<team>.cloudflareaccess.com`; the Worker reads the keys at
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (same page).

## 2. Deployment values

`packages/worker/wrangler.deploy.example.jsonc` lists every deployment value with comments for both layouts. Fill it:

| Key                                    | Value                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `account_id`                           | the account ID, when the credentials reach several accounts; otherwise leave the key out |
| `routes`                               | the Custom Domains and routes of section 1                                               |
| `d1_databases`, `r2_buckets`           | `<DATABASE_NAME>` and the database ID; `<BUCKET_NAME>`                                   |
| `kv_namespaces`                        | the binding `OAUTH_KV` and the namespace ID (Planned (OAuth))                            |
| `vars.APP_HOST` … `PUBLIC_HOST_SUFFIX` | the hosts of the chosen layout                                                           |
| `vars.ARCHIVE_AFTER_DAYS`              | days until an untouched artifact is archived (design.md section 5)                       |
| `vars.ACCESS_*`                        | the team domain and the two AUD tags                                                     |

`API_TOKENS` is a secret, optional from the OAuth release, and never part of these values (section 4). The values live
in two places, never both at once:

- **Workers Builds:** the build variable `ARTIFACTS_DEPLOY_JSONC` holds the whole file, comments included.
- **The owner's machine:** `packages/worker/wrangler.deploy.jsonc`, which git ignores.

Give each route a `zone_name` rather than a `zone_id`: the deploy checks that the route's host is in the zone it names,
while a `zone_id` is checked for its form only, and a wrong one fails at `wrangler deploy`, after the migrations.

One variable holding the file, rather than a variable per value, keeps one format, one parser and one set of tests for
both paths; the routes and bindings are lists, which separate variables would hold as JSON anyway. A build variable is
limited to 5 KB and a Worker to 64 of them
([limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)); the file is about 2 KB. None of
the values is a credential, so a plain build variable, which the dashboard shows again, is enough; a build secret works
the same.

`node scripts/deploy.ts` refuses to start, naming each problem, when the values are missing, set in both places, not
JSONC, or leave a value empty, and when a variable fails the Worker's own configuration check (HOST-2), a host is a
`localhost` name or has a port (ACC-2), a key belongs in `wrangler.jsonc`, `API_TOKENS` appears, a route would serve
hosts that are not the deployment's, or a route repeats another, is outside its `zone_name`, or sets both `zone_name`
and `zone_id`. From the OAuth release it also refuses values without a `kv_namespaces` entry for `OAUTH_KV` whose ID
is 32 hexadecimal characters. The committed example is refused for its empty values.

## 3. Deploying

### Workers Builds

Connect the repository after the first release exists (section 6), from **Workers & Pages → Create application** with
the GitHub repository ([Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)), or later from the Worker's
**Settings → Builds → Connect**. The GitHub App that Cloudflare installs needs access to this repository only.

| Setting                                  | Value                                                      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker name                              | `artifacts`                                                | the build fails unless it is the `name` in the root directory's `wrangler.jsonc` ([name requirement](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement))                                                                                                                                                                                                                                                                                                                           |
| Branch control                           | production branch `release`; **Enable Preview Builds** off | only releases deploy; a preview build would run `wrangler preview` for every other branch ([build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/))                                                                                                                                                                                                                                                                                                                                           |
| Root directory                           | `packages/worker`                                          | where `wrangler.jsonc` is and the commands run ([monorepos](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/#monorepos))                                                                                                                                                                                                                                                                                                                                                                                |
| Build command                            | `node scripts/install.ts`                                  | installs the workspace with the pnpm version of `mise.lock`: `npx --yes pnpm@<version> install --frozen-lockfile` at the repository root, so the image's pnpm (Corepack's default, 9.x) never runs the install. It first checks that Node is the version of `.node-version`, and refuses to start, naming the problem, when either version cannot be read or Node differs                                                                                                                                                      |
| Deploy command                           | `node scripts/deploy.ts`                                   | the deploy script below; it runs the Wrangler of the lockfile from `node_modules/.bin` and needs no pnpm                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Build variable `ARTIFACTS_DEPLOY_JSONC`  | the deployment values (section 2)                          | build variables reach the build, not the Worker at run time (configuration page). **Observed:** the deploy command reads it; the script names the variable if it is missing                                                                                                                                                                                                                                                                                                                                                    |
| Build variable `SKIP_DEPENDENCY_INSTALL` | `1`                                                        | without it, Builds installs the whole workspace with its own pnpm before the build command, even with a root directory set (a build log in [workers-sdk#10941](https://github.com/cloudflare/workers-sdk/issues/10941) shows `Installing project dependencies: pnpm install --frozen-lockfile` and `Scope: all 26 workspace projects`); the variable turns that off ([build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)). The build command refuses to run in Builds (`WORKERS_CI`) without it |
| API token                                | a token of your own, see below                             | the token Builds creates has Workers Scripts, KV and R2 edit, Workers Routes edit and account read, but no D1 permission ([API token](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)), and the deploy applies D1 migrations                                                                                                                                                                                                                                                                  |

The dashboard holds no tool version; each build uses those of the commit it builds:

- **Node.js:** Builds reads `.node-version` from the root directory
  ([build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)). `packages/worker/.node-version`
  is a symbolic link to the repository's `.node-version`, which mise reads too. It holds the major only: the mise update
  workflow advances `mise.lock` within it, and Builds picks the release of that major. **Observed:** the checkout of
  Builds keeps the link: the first build installed the latest release of that major instead of using the image's default
  Node. If that changes, Builds uses its default Node, and the build command refuses once that is not the major of
  `.node-version`.
- **pnpm:** the version of `mise.lock`, which the build command reads and the mise update workflow advances.

The API token is a user token with the permissions of the generated one plus **D1 edit** on the account.
**Unconfirmed:** the exact permission names in the token form, and whether creating the Custom Domains needs more than
Workers Routes edit; the first build's log shows a missing permission.

Workers Builds runs the build and deploy commands and nothing else. Nothing in its documentation applies D1 migrations;
Cloudflare's documentation for Deploy to Cloudflare buttons tells a project to apply them in its `deploy` script
([deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)), which is what this one does.
**Unconfirmed:** a statement in the Builds documentation that it does not apply them.

### What `node scripts/deploy.ts` does

`scripts/deploy.ts` reads the deployment values, checks them (section 2) and merges them into `wrangler.jsonc` as
`.wrangler-deploy-<random>.json` next to it, removed on every exit. Then, each step stopping the rest when it fails:

1. `wrangler r2 bucket info <BUCKET_NAME>`: the bucket must exist, since `wrangler deploy` would create a new, empty one
   for a mistyped name. From the OAuth release, `wrangler kv namespace list` must list the namespace ID too: the
   documentation describes provisioning only for a binding without an ID and does not say what a wrong ID does, and a
   new, empty namespace would sign every client out.
2. `wrangler d1 migrations apply DB --remote`, **on every deploy**: the code of a release expects the schema of that
   release, and the command applies only the migrations not yet applied (`d1_migrations` records them;
   [migrations](https://developers.cloudflare.com/d1/reference/migrations/)). A flag would let a release deploy against
   an old schema. Its confirmation prompt is skipped: declining it exits successfully, so the deploy would go on.
   Because the migrations land before the code, and stay after a rollback, **a migration must keep the previous
   release's code working**.
3. `wrangler deploy`.

Each wrangler command may run for 10 minutes (a build may run for 20,
[limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)). It runs in a process group of its
own, since Wrangler runs in a second process that a signal to the first does not always reach: SIGINT, SIGTERM and
SIGHUP (Ctrl-C included) are passed on to the whole group, a timeout sends it SIGTERM, SIGKILL follows 10 seconds
later, and no other command starts. The merged configuration is removed once no process of the group is left, or
once SIGKILL has been sent.

A release deploys when its PR is merged: the build appears under the Worker's **Deployments → View build history**
([builds](https://developers.cloudflare.com/workers/ci-cd/builds/#view-build-and-preview-url)).

### From the owner's machine

The same script with the values in `wrangler.deploy.jsonc`, for the first deployment before Builds is connected or when
Builds is unavailable. Deploy what `release` holds, so the next build does not replace something else. From
`packages/worker`:

```sh
git fetch origin && git switch --detach origin/release
node scripts/install.ts                             # the whole workspace, with the pnpm of mise.lock
pnpm exec wrangler login
node scripts/deploy.ts
git switch -                                        # back to the branch you were on
```

### Rolling back

```sh
pnpm exec wrangler versions list                    # pick the version to return to
pnpm exec wrangler rollback <VERSION_ID> --message "<why>"
```

A rollback makes the chosen version active on every route and domain at once and changes no bound resource
([rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)): D1 keeps its newer schema
and rows, which is why migrations must keep the previous code working. Each version keeps the secrets it was deployed
with, so **after a rollback, put `API_TOKENS` again** if a token was revoked since that version (inferred from secrets
being part of a version and preserved into the next,
[secrets](https://developers.cloudflare.com/workers/configuration/secrets/); the rollbacks page does not say). The next
release replaces the rollback; to stay on old code, revert on `main` and release. A rollback to a version before the
OAuth release answers OAuth clients with 401 and serves no metadata, so they cannot sign in until the next release;
keep an API token for the CLI until OAuth has run for a while.

## 4. API tokens and OAuth grants

### API tokens

Each agent gets its own token, named after it (design.md section 7); the name is recorded on every version it publishes.
From the OAuth release, tokens are for automation that cannot sign in (a CI job, `claude -p` before any
`claude mcp login`), and a deployment may have none. `artifacts token` needs no configuration:

```sh
artifacts token codex
# art_…                                       the token, printed once: give it to the agent (section 5)
# "codex": "<64 hex>"                         its entry for API_TOKENS
```

`API_TOKENS` is one JSON object of every entry. Keep that object (it holds hashes, not tokens) outside the repository,
here `~/artifacts/api-tokens.json`, and put it whole:

```sh
pnpm exec wrangler secret put API_TOKENS < ~/artifacts/api-tokens.json
```

`wrangler secret put` reads the value from standard input when piped, and creates and deploys a new version at once
([`secret put`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-put)), and a deployment
never deletes a secret ([`deploy`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)). Until
the first put, the Worker answers 503 on every host; from the OAuth release it serves OAuth only instead.

- **Rotate:** run `artifacts token <name>` again, replace the entry, put the object, then update the agent; the old
  token is refused from the put on.
- **Revoke:** remove the entry and put the object. The token is refused from the next request (TOK-1).
- **Turn all off** (Planned (OAuth)): put `{}`, or `pnpm exec wrangler secret delete API_TOKENS`. Every API token is
  refused from the next request, and OAuth clients keep working (AC-18). A malformed object still answers 503.

### OAuth grants (Planned (OAuth))

Each client the owner allows on the consent page gets a grant, named on that page with the publisher name it records
on versions (design.md section 7). With any credential the CLI can use:

```sh
artifacts grants                                    # id, publisher, client, redirect host, resource, created, expires
artifacts revoke <grant>                            # one grant and its tokens
```

Until the CLI has these commands (design.md, "OAuth delivery", step 8), the same through REST, with an API token in
`TOKEN`:

```sh
API=https://artifacts-api.example.com
curl -s "$API/v1/grants" -H "Authorization: Bearer $TOKEN" | jq '.grants[] | {id, publisher, client_name, redirect_host}'
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$API/v1/grants/<grant>" -H "Authorization: Bearer $TOKEN"
```

- **Revocation is final** once it answers 204. A 503 may have revoked part: run it again until it answers 204, or 404
  when the earlier call had finished after all.
- **Sign a client out:** `artifacts logout` for the CLI, which revokes its own grant as above; `claude mcp logout
  artifacts` for Claude Code, which revokes at the server through RFC 7009 ([MCP](https://code.claude.com/docs/en/mcp))
  with the same lasting effect (design.md section 7). Removing a server from a client's configuration only forgets its
  tokens: revoke its grant here as well.
- **A grant expires** after 30 days without a refresh; a client in use refreshes it. Signing a client in again
  replaces its grant only when it returns with the same client and redirect URI: Claude Code and Codex pick a new
  loopback port each time, so revoke the grant they leave behind.
- **Revocation takes up to a minute or more** to reach every Cloudflare location, longer where the token was just
  read (design.md section 7). Until then the revoked tokens can still work there.
- **Revoke every grant at once,** for a leak whose extent is unknown: create a new namespace (section 1), replace the
  old ID with it in the build variable, and deploy what `release` holds from the owner's machine with the same values
  (section 3). The new version reads only the new, empty namespace, so every OAuth token is refused at once and every
  client signs in again. Delete the old namespace afterwards with
  `pnpm exec wrangler kv namespace delete --namespace-id <OLD_ID>`.

## 5. Clients

Agents use MCP over streamable HTTP at `https://artifacts-api.example.com/mcp`. Until the OAuth release each sends
`Authorization: Bearer <token>`. From it (Planned (OAuth)), each signs in with OAuth instead and the consent page opens
in the browser: check the client and the redirect host it shows, name the publisher and allow (design.md section 7).
Claude Code uses a configured `Authorization` header in place of OAuth and Codex tries it first, so remove the header
when moving a client to OAuth.

**Claude Code** ([MCP](https://code.claude.com/docs/en/mcp)):

```sh
claude mcp add --transport http --scope user artifacts https://artifacts-api.example.com/mcp
claude mcp login artifacts                          # OAuth (Planned (OAuth)); or, with an API token:
# claude mcp add ... --header "Authorization: Bearer <token>"
claude mcp get artifacts
```

To move from the header to OAuth, `claude mcp remove artifacts` and add the server again without it. `claude -p`
cannot sign in by itself: run `claude mcp login` first.

**Codex CLI**, in `~/.codex/config.toml` ([MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)):

```toml
[mcp_servers.artifacts]
url = "https://artifacts-api.example.com/mcp"
# with an API token instead of OAuth: bearer_token_env_var = "ARTIFACTS_CODEX_TOKEN"
```

Then `codex mcp login artifacts` (Planned (OAuth)).

**claude.ai and Claude Desktop** (Planned (OAuth)): **Customize → Connectors → Add → Add custom connector**, with the
URL above, signing in with **Use Claude's published identity**
([custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)).
Claude reaches the server from Anthropic's infrastructure, which the API host allows like any client.

**Gemini CLI** (Planned (OAuth)), in `~/.gemini/settings.json`, then `/mcp auth artifacts` in a session
([MCP servers](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)):

```json
{ "mcpServers": { "artifacts": { "httpUrl": "https://artifacts-api.example.com/mcp" } } }
```

**Any other client** that speaks streamable HTTP takes the URL, and signs in with OAuth or sends the header. A raw
call, with the token in `TOKEN`, also checks the server by hand:

```sh
curl -sS https://artifacts-api.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**The CLI** ([packages/cli/README.md](../packages/cli/README.md)), from the repository root, with `~/.local/bin` on
`PATH`:

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/packages/cli/src/main.ts" ~/.local/bin/artifacts
export ARTIFACTS_API_URL=https://artifacts-api.example.com ARTIFACTS_TOKEN=<token>
```

From the OAuth release (Planned (OAuth)), the CLI has a runtime dependency: run `pnpm install --frozen-lockfile` at
the repository root first, and again after pulling a change to the lockfile. Then sign in instead of setting
`ARTIFACTS_TOKEN`, which, when set, still takes precedence:

```sh
export ARTIFACTS_API_URL=https://artifacts-api.example.com
artifacts login                                     # opens the consent page; stores ~/.config/artifacts/credentials.json
```

## 6. First deployment

1. Section 1: Workers Paid, zones, the wildcard record, the D1 database, the R2 bucket, the KV namespace (from the
   OAuth release), the two Access applications.
2. Fill the deployment values (section 2).
3. `gh infra apply`: it restricts who can push to `release` (below), adds the release-please labels and allows its
   action. Until then the release workflow fails on every push to `main`, since the action is not allowed; the next
   push after the apply runs it.
4. Merge the first release PR; the release workflow creates `release` at its tag.
5. Connect Workers Builds (section 3); its first build deploys. Its log shows Node of the major in `.node-version`
   among the tools Builds detected, no `Installing project dependencies` before the build command, and
   `install: pnpm <version> from mise.lock` followed by pnpm's `Done in … using pnpm v<version>`.
6. Generate a token per agent and put `API_TOKENS` (section 4), or, from the OAuth release, only for the clients that
   cannot sign in; configure the clients (section 5).
7. Run the checklist (section 7).

### Upgrading to the OAuth release (Planned (OAuth))

1. Before merging the release PR that carries the OAuth storage binding (design.md, "OAuth delivery", step 1): create
   the KV namespace (section 1) and add its `kv_namespaces` entry to the deployment values (section 2), in the build
   variable and in `wrangler.deploy.jsonc` if you keep one. Without it the deploy stops at the values check, and the
   previous release keeps serving.
2. After the release that accepts OAuth tokens deploys: run checks 9 to 13 of section 7, then move each client to OAuth
   (section 5) and its API token out of `API_TOKENS`. From this release a token of the form `<a>:<b>:<c>`, which only
   a token made by hand can have, is read as an OAuth token and refused (design.md section 7): replace it with one
   from `artifacts token`.
3. Once no client needs one, turn API tokens off (section 4) and run check 15, or keep one for automation.

### Restrict pushes to `release`

A push to `release` deploys, so only the release workflow's App may update it. The `release` ruleset in
`.github/infra.yaml` does this, naming the repository's App by its numeric ID (a private App is named as `id:<APP_ID>`;
[gh-infra rulesets](https://github.com/babarot/gh-infra/blob/main/docs/src/content/docs/resources/repository/rulesets.md)).
`gh infra apply` reconciles rulesets authoritatively, so a ruleset made in the GitHub settings would be deleted by the
next apply; change it in the file. A copy of the repository with its own App puts that App's ID there. Check with
`gh infra plan` before applying.

## 7. Post-deployment checklist

What the local tests cannot show, checked once after the first deployment and after a change to the setting involved.
The commands run in an empty scratch directory, with a check token and a probe artifact:

```sh
API=https://artifacts-api.example.com
TOKEN=<token>                                       # a token named "check" (section 4)
mkdir -p probe && echo '<p>probe</p>' > probe/index.html
ID=$(ARTIFACTS_TOKEN=$TOKEN artifacts publish ./probe --title probe --json | jq -r .artifact.id)
```

Logs below are the Worker's Workers Logs in the dashboard, kept 7 days on Workers Paid
([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)).

1. **R2's rate limit is recognized (error 10058).** R2 answers a second write to a key within a second with 429, code
   10058 ([error codes](https://developers.cloudflare.com/r2/api/error-codes/)); the Worker retries that twice and
   reports anything else as an error. Send 20 updates from the same base with the same new bytes at once:

   ```sh
   head -c 65536 /dev/urandom > big.bin
   ( for i in $(seq 20); do
       curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/artifacts/$ID/versions" -H "Authorization: Bearer $TOKEN" \
         -F 'meta={"base_version":1,"files":[{"path":"big.bin"}]}' -F 'file=@big.bin' &
     done; wait ) | sort | uniq -c
   ```

   Pass: one `201`, the rest `409` or `500`; every `operation.failed` line for `$ID` has `"reason":"rate_limited"`,
   none `"reason":"error"`. No `500` means R2 limited nothing this time: run it again.

2. **`//` at the edge.** The zone's URL normalization runs before the Worker; the default type, RFC 3986, removes dot
   segments only, and the Cloudflare type also merges successive slashes
   ([settings](https://developers.cloudflare.com/rules/normalization/settings/),
   [how it works](https://developers.cloudflare.com/rules/normalization/how-it-works/)).

   ```sh
   ARTIFACTS_TOKEN=$TOKEN artifacts public "$ID" on
   for p in /index.html //index.html /_v/1//index.html; do
     curl -s -o /dev/null -w "$p %{http_code}\n" --path-as-is "https://$ID-pub.example.com$p"; done
   ```

   Pass: `/index.html` 200; the other two 404 under RFC 3986 (the Worker refuses an empty segment) or 200 with the
   probe's page under Cloudflare normalization. Never another file.

3. **Access on the real hosts.**

   ```sh
   for u in https://artifacts.example.com/ "https://$ID-art.example.com/" "https://$ID-pub.example.com/"; do
     curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "$u"; done
   curl -s https://<team>.cloudflareaccess.com/cdn-cgi/access/certs | jq '.keys | length'
   ```

   Pass: the app and content hosts redirect to `https://<team>.cloudflareaccess.com/…`; the public host answers 200 from
   the Worker without a redirect; the key set has at least one key, so `ACCESS_TEAM_DOMAIN` names the right team. In a
   browser: the owner signs in and sees the gallery and the probe; another identity is denied (AC-6); on the probe's
   page, `document.cookie` in the console shows no `CF_Authorization` (ACC-3). The 503 for a key set the Worker cannot
   fetch is **not checked on the deployment**: the only way to cause it is to deploy a wrong team domain, which takes
   every private page down meanwhile. `src/access.test.ts` pins it (PL-3), and `access.unavailable` in the logs shows it
   if it happens.

4. **Production waits** (R2 30 s, D1 reads 10 s, the key set 5 s). They cannot be provoked on the platform; check that
   the deployed release holds them, in the checkout:

   ```sh
   git fetch origin release && git show origin/release:packages/worker/src/timeout.ts | grep -E 'Ms: [0-9]'
   ```

   Pass: `accessKeysMs: 5_000`, `r2Ms: 30_000`, `d1ReadMs: 10_000`, and the commit of the latest build under
   **View build history** is `git rev-parse origin/release`. A wait that fires logs `"reason":"timeout"` or
   `access.unavailable`.

5. **A real MCP client.** The `curl` of section 5 lists the nine tools: `create_artifact`, `update_artifact`,
   `list_artifacts`, `get_artifact`, `list_versions`, `read_file`, `set_public`, `set_archive`, `delete_artifact`; the
   same call without the header answers 401. In Claude Code and in Codex CLI, `/mcp` shows `artifacts` connected with
   those tools, and asking each to publish a page and list artifacts calls `create_artifact` and `list_artifacts`
   (AC-1, AC-11).

6. **Public share hosts** (AC-9).

   ```sh
   curl -sI "https://$ID-pub.example.com/" | grep -i -E '^(HTTP|cache-control|cross-origin-resource-policy|location)'
   curl -s -o /dev/null -w '%{http_code}\n' "https://$ID-pub.example.com/_v/1/"
   ARTIFACTS_TOKEN=$TOKEN artifacts public "$ID" off
   curl -s -o /dev/null -w '%{http_code}\n' "https://$ID-pub.example.com/"
   ```

   Pass: `200`, `cache-control: no-cache`, no `cross-origin-resource-policy`, no `location`; the pinned version `200`;
   after `off`, `404`.

7. **Gallery CSP** (ISO-5). In the signed-in browser's developer tools, the responses of `/` and of `/no-such-page`
   (404) carry `Content-Security-Policy: default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self';
   base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, and the page loads its stylesheet, fonts and icon
   without a CSP error.

8. **Logs** (DATA-1). In the logs: the probe's `artifact.created` and `artifact.changed` lines carry `"token":"check"`;
   a search for `art_` (the token prefix) and for `Bearer` finds nothing; filtering on `$cloudflare.$metadata.type =
   "cf-worker-event"`, which marks invocation logs, finds nothing, since `wrangler.jsonc` turns them off ([invocation
   logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)).

The checks below are Planned (OAuth): run 9 to 13 once the release that accepts OAuth tokens deploys, 14 once the
CLI signs in, and 15 when API tokens are turned off.

9. **OAuth discovery** (design.md section 7). From the Worker, not an Access redirect, which also shows the API host's
   Bypass (section 1):

   ```sh
   curl -s "$API/.well-known/oauth-authorization-server" \
     | jq '{issuer, authorization_endpoint, client_id_metadata_document_supported, code_challenge_methods_supported}'
   curl -s "$API/.well-known/oauth-protected-resource/mcp" | jq '{resource, authorization_servers}'
   curl -s -o /dev/null -D - -X POST "$API/mcp" | grep -i -E '^(HTTP|www-authenticate)'
   curl -s -o /dev/null -D - -X POST "$API/oauth/token" -H 'Origin: https://example.org' | grep -i -c access-control
   curl -s -o /dev/null -w '%{http_code}\n' "https://$ID-pub.example.com/.well-known/oauth-authorization-server"
   ```

   Pass: `issuer` is `$API`, `authorization_endpoint` `https://artifacts.example.com/oauth/authorize`,
   `client_id_metadata_document_supported` `true`, `["S256"]`; the resource is `$API/mcp` with `["$API"]`; the
   `POST` answers 401 with `Bearer resource_metadata="$API/.well-known/oauth-protected-resource/mcp"`; no
   `access-control-*` header (`0`); the public host answers `404`, as for any path the probe lacks.

10. **Real clients** (AC-14, AC-15). Sign in Claude Code, Codex CLI, claude.ai and Gemini CLI (section 5). Pass: each
    consent page names the client, with `claude.ai` or `chatgpt.com` as the domain of a CIMD client and "registered
    itself" for Gemini CLI, and shows its redirect host; after **Allow**, `/mcp` lists the nine tools and a publish
    works; a day later a call works without a new sign-in. For a client that cannot sign in, note the step that failed
    and the client's version.

11. **Consent page** (AC-19, ISO-5). In the browser's developer tools, the consent page for Claude Code carries
    `Content-Security-Policy` with `form-action 'self' http://localhost:<port>` and `frame-ancestors 'none'`, and
    `X-Frame-Options: DENY`; the redirect after **Allow** is not blocked. An authorization URL opened in a private
    window as another identity is denied by Access.

12. **Publisher and logs** (AC-17, DATA-1). The version a signed-in client published shows its publisher name in the
    gallery; its `artifact.created` line carries that name and the grant's ID, and `grant.created` names the same
    grant. A search of the logs for `owner:`, the start of every OAuth token, finds nothing.

13. **Revocation** (AC-20). List the grants and revoke Claude Code's with the check token, as section 4 shows
    (`artifacts grants` and `artifacts revoke <grant>` once the CLI has them), then have Claude Code call a tool every
    10 s. Pass: the `DELETE` answers `204`; the calls are refused within 5 minutes, this project's threshold, since
    Cloudflare documents no bound on KV's propagation; afterwards `/mcp` asks to sign in again, and the grant stays out
    of the listing. Note the delay.

14. **The CLI's sign-in** (AC-16). `artifacts login`; `ls -l ~/.config/artifacts/credentials.json` shows
    `-rw-------`; `artifacts list` works without `ARTIFACTS_TOKEN`. Publish a second probe, so the two publishes below
    cannot conflict:

    ```sh
    mkdir -p probe2 && echo '<p>probe 2</p>' > probe2/index.html
    ID2=$(artifacts publish ./probe2 --title probe2 --json | jq -r .artifact.id)
    ```

    More than an hour later, when the stored access token has expired, start both publishes from one command line.
    This is a smoke check: the shell starts both together but cannot hold them where each reads the stored token, so
    they usually, not always, both read the expired token before either refreshes; PL-50 holds them at barriers in
    the local tests.

    ```sh
    artifacts publish --id "$ID" ./probe & artifacts publish --id "$ID2" ./probe2 & wait
    ```

    Pass: both print a new version; another hour later `artifacts list` still works without signing in again, so the
    file kept the token the server holds. Then `artifacts logout`; `artifacts list` fails, naming `artifacts login`;
    the grant listing (section 4) no longer shows the CLI's grant.

15. **API tokens off** (AC-18). The `curl` of section 5 with the check token answers 401, and a signed-in client still
    works.

Afterwards: `ARTIFACTS_TOKEN=$TOKEN artifacts delete "$ID"` (and `"$ID2"` after check 14), revoke the check token,
and revoke the grants made only for the checks.

## 8. Backups and restore

D1 Time Travel restores the database to any minute of the last 30 days (Workers Paid). A restore overwrites the
database in place, cancels queries in flight, and prints a bookmark that undoes it
([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)):

```sh
pnpm exec wrangler d1 time-travel info <DATABASE_NAME> --timestamp=2026-11-16T09:00:00Z
pnpm exec wrangler d1 time-travel restore <DATABASE_NAME> --timestamp=2026-11-16T09:00:00Z
```

The restore covers rows and schema alike, `d1_migrations` included; the next deploy applies the migrations again.

Not backed up (design.md section 11):

- **File bytes in R2.** Restoring rows of an artifact deleted after the restore point brings back versions whose objects
  the deletion removed: their files fail to load. Artifacts created after the point lose their rows; their objects stay,
  unreferenced, until removed by hand.
- **`API_TOKENS`**, which can be read back from nowhere: keep the object of entries; a lost token is replaced (section
  4).
- **OAuth storage (KV)** (Planned (OAuth)): clients, grants and tokens. Losing it costs each client one sign-in;
  a D1 restore does not touch it.
- **The deployment values**: keep `wrangler.deploy.jsonc` or a copy of the build variable.
- **Access applications and Workers Builds settings**, recreated from sections 1 and 3.
- **Logs**, kept 7 days.
