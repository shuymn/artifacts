# Operations

How the owner sets up, deploys, releases and checks a deployment of `artifacts`, and restores its metadata. The design
is in [design.md](design.md) (section 1 for hosts, section 11 for operations); the invariants named here (`ACC-2`,
`DATA-1` and so on) are in [threat-model.md](threat-model.md).

Values in angle brackets are placeholders, and the hosts below are the examples of design.md section 1:
`artifacts.example.com` (`APP_HOST`), `artifacts-api.example.com` (`API_HOST`), `-art.example.com`
(`CONTENT_HOST_SUFFIX`) and `-pub.example.com` (`PUBLIC_HOST_SUFFIX`) on one shared domain, or `-p.example-content.net`
and `-s.example-content.net` for content on its own registrable domain. `<team>` is the Zero Trust team name,
`<DATABASE_NAME>` the D1 database, `<BUCKET_NAME>` the R2 bucket. None of them is written in this repository (P7).

Commands run from `packages/worker`, with the tools mise installs from `mise.toml` and `.node-version`: there
`pnpm exec wrangler` is the Wrangler of the lockfile and `wrangler.jsonc` names the Worker. A block that starts elsewhere
says so. `artifacts` is the CLI, installed as in section 5. A claim about Cloudflare or another product links the page
that states it; **Unconfirmed** marks one the documentation does not state, and **Observed** one the documentation
does not state but a deployment of this repository showed.

## How a change reaches the deployment

```text
main ──(release-please keeps a release PR open)──> merge the release PR ──> tag vX.Y.Z and a draft release
     ──(.github/workflows/release.yml builds the CLI binaries and publishes)──> published release
     ──(release.yml fast-forwards)──> release ──(Workers Builds)──> scripts/deploy.ts
```

- `main` takes every change, dependency updates included, and is never deployed.
- release-please keeps one release PR open with the next version and the changelog, from the Conventional Commits on
  `main` (one version for the repository: the `node` release type on the root package, tags `vX.Y.Z`, first release
  `0.1.0`; `release-please-config.json`, `.release-please-manifest.json`). Merging it tags the release and creates it
  as a draft: `draft` keeps it unpublished, and `force-tag-creation` creates the tag with the draft, at the release's
  commit, since GitHub creates a draft's tag only when it is published.
- Releases are immutable (`release_immutability` in `.github/infra.yaml`): once published, a release's assets cannot
  change, its tag cannot be moved or deleted, and deleting the release does not free its tag name
  ([immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).
  So the binaries go up while the release is a draft, and a bad release is fixed by the next one.
- The release workflow then runs, in order, in the same run:
  1. **prepare** runs release-please and finds the draft to finish: the one release-please just created; in a run
     started again, the draft at the run's commit; in a manual run with `tag`, that tag's draft. It checks that the tag
     is at the draft's commit and that the commit is on `main`. An ordinary push finds none and goes to step 4.
  2. **build** (`.github/workflows/cli-binaries.yml`) builds the CLI's binary at that commit on each platform's own
     runner: macOS arm64, Linux x64 and arm64 (glibc), Windows x64. Each checks that the root package's version is the
     tag's, runs the smoke tests against the binary unpacked from its archive, and hands the archive to the next job.
  3. **publish** runs only when every platform passed. It checks the four archives (names, the binary alone at the
     root), writes `SHA256SUMS`, uploads them to the release while it is still a draft (replacing the assets an
     earlier attempt left), checks the draft's assets against the files (size, and digest when GitHub gives one) and
     publishes the release.
  4. **fast-forward** moves the `release` branch to the latest published release. It refuses a release that is not a
     commit of `main` and an update that is not a fast-forward: it updates the branch with `force=false`, which GitHub
     refuses unless the update is a fast-forward
     ([update a reference](https://docs.github.com/en/rest/git/refs#update-a-reference)). It runs on every push to
     `main` and in every manual run, after publish when the run finishes a draft.
- A draft never moves `release`. **A failing binary build blocks deployment until it is fixed:** a platform that does
  not build or fails its smoke tests leaves the release a draft, and `release` stays at the previous release.
- Workers Builds deploys each push to `release` and nothing else.

The same platforms build and run the smoke tests in CI for every pull request that can change a binary (`packages/cli`,
the root `package.json`, the lockfiles, `mise.toml`, the binaries workflow), so a build that would block a release
fails before it is merged. That check is not required.

### Recovering a release

- **A failure outside the code** (a runner, the network, GitHub's API) during prepare, build or publish: run the failed
  jobs again from the run's page, or run the release workflow manually on `main` with `tag` set to the draft's tag
  (`gh workflow run release.yml --ref main -f tag=vX.Y.Z`). Either finishes the same draft at the same commit: it
  checks the tag again, builds the binaries, replaces the draft's assets and publishes. Assets change only while the
  release is a draft; publish refuses a release that is no longer one, and a draft holding an asset the workflow does
  not make (remove it on the release's page first).
- **A failure the code causes** (a build or a smoke test that fails): the tag cannot move, so this release cannot carry
  the fix. Fix it on `main` and merge the next release PR; its draft is finished as usual and deployment resumes. The
  failed release stays a draft and never deploys; delete it on the releases page (its tag stays).
- **Publish succeeded but the fast-forward failed:** the fast-forward reads only the latest published release from
  GitHub, so running the failed job again, a manual run or the next push to `main` repairs it.

Every job that writes uses the repository's GitHub App token (`APP_CLIENT_ID`, `APP_PRIVATE_KEY`; `pnpm run github-app`
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
| `vars.APP_HOST` … `PUBLIC_HOST_SUFFIX` | the hosts of the chosen layout                                                           |
| `vars.ARCHIVE_AFTER_DAYS`              | days until an untouched artifact is archived (design.md section 5)                       |
| `vars.ACCESS_*`                        | the team domain and the two AUD tags                                                     |

`API_TOKENS` is a secret and never part of these values (section 4). The values live in two places, never both at once:

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
and `zone_id`. The committed example is refused for its empty values.

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
   for a mistyped name.
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
release replaces the rollback; to stay on old code, revert on `main` and release.

## 4. API tokens

Each agent gets its own token, named after it (design.md section 7); the name is recorded on every version it publishes.
`artifacts token` needs no configuration:

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
the first put, the Worker answers 503 on every host.

- **Rotate:** run `artifacts token <name>` again, replace the entry, put the object, then update the agent; the old
  token is refused from the put on.
- **Revoke:** remove the entry and put the object. The token is refused from the next request (TOK-1).

## 5. Clients

Agents use MCP over streamable HTTP at `https://artifacts-api.example.com/mcp` with `Authorization: Bearer <token>`;
there is no OAuth (design.md section 7).

**Claude Code** ([MCP](https://code.claude.com/docs/en/mcp)):

```sh
claude mcp add --transport http --scope user artifacts https://artifacts-api.example.com/mcp \
  --header "Authorization: Bearer <token>"
claude mcp get artifacts
```

**Codex CLI**, in `~/.codex/config.toml`, with the token in the environment
([MCP](https://developers.openai.com/codex/mcp)):

```toml
[mcp_servers.artifacts]
url = "https://artifacts-api.example.com/mcp"
bearer_token_env_var = "ARTIFACTS_CODEX_TOKEN"
```

**Any other client** that speaks streamable HTTP with a static header takes the URL and the header. A raw call, with
the token in `TOKEN`, also checks the server by hand:

```sh
curl -sS https://artifacts-api.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**The CLI** ([packages/cli/README.md](../packages/cli/README.md)): the binary of the latest release, through mise's
github backend, or from the release's archive checked against its `SHA256SUMS`:

```sh
mise use -g github:shuymn/artifacts
export ARTIFACTS_API_URL=https://artifacts-api.example.com ARTIFACTS_TOKEN=<token>
```

## 6. First deployment

1. Section 1: Workers Paid, zones, the wildcard record, the D1 database, the R2 bucket, the two Access applications.
2. Fill the deployment values (section 2).
3. `gh infra apply`: it restricts who can push to `release` (below), adds the release-please labels and allows the
   actions the workflows use (release-please, and `actions/upload-artifact` and `actions/download-artifact`, which hand
   the binaries to the publish job). Until then the release workflow fails on every push to `main`, since the action is
   not allowed; the next push after the apply runs it.
4. Merge the first release PR; the release workflow publishes it with the CLI binaries and creates `release` at its
   tag.
5. Connect Workers Builds (section 3); its first build deploys. Its log shows Node of the major in `.node-version`
   among the tools Builds detected, no `Installing project dependencies` before the build command, and
   `install: pnpm <version> from mise.lock` followed by pnpm's `Done in … using pnpm v<version>`.
6. Generate a token per agent and put `API_TOKENS` (section 4); configure the clients (section 5).
7. Run the checklist (section 7).

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

Afterwards: `ARTIFACTS_TOKEN=$TOKEN artifacts delete "$ID"`, and revoke the check token.

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
- **The deployment values**: keep `wrangler.deploy.jsonc` or a copy of the build variable.
- **Access applications and Workers Builds settings**, recreated from sections 1 and 3.
- **Logs**, kept 7 days.
