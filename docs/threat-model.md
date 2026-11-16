# Threat model

What `artifacts` protects, from whom, and the security invariants the code must keep, by ID (for example `ISO-2`). It
covers security only; correctness and design are in [design.md](design.md), libraries and patterns in
[decisions.md](decisions.md).

**Keep it current.** A change that adds an entry point, asset, trust boundary or accepted risk, or changes an
invariant's status, updates this file. IDs are never reused: an invariant that no longer applies is marked retired
with the reason.

## Status and pinning

**Enforced (main):** the cited source and test exist on `main`. **Planned (first release):** not implemented; required
before the first release ships. **Planned (OAuth):** decided in [design.md](design.md#7-auth) for OAuth sign-in and not
implemented; the plan-layer rows named are its tests. An invariant enforced for API tokens and planned for OAuth says
which part is which. Each invariant below states its status; source and test paths are under `packages/worker/`. A
**Gap** note names a part no test pins yet; that part does not count as enforced. A **Changed for OAuth** note says
what an invariant gave up and why the purpose keeps what it protected.

Each invariant names how it is pinned:

- **Behavior:** a test drives the Worker in the local runtime with D1 and R2, or a unit, and checks the result
  (status, headers, rows, objects).
- **Log redaction:** a behavior test sends marker values (tokens, JWTs, file bytes, titles, paths) through a path,
  captures every `console` method, and asserts that no marker appears.
- **Source check:** a test reads the sources or configuration for a shape no behavior shows: the logging sink and the
  deployment configuration only.
- **Review:** a property no test can observe, checked when the code changes.
- **Deployed check:** a setting outside the repository, checked on the deployed Worker with a browser or a client as
  the purpose layer of [design.md](design.md#purpose-layer-acceptance-criteria) lists.

## Deployment assumptions

- One owner deploys and uses a deployment; agents act for the owner with their own credentials: API tokens, or OAuth
  grants the owner approved.
- One Worker serves the app host (the gallery), the API host (REST and MCP), a host per artifact for private content,
  and a host per artifact for public content. Hosts sit under one domain the owner already uses or put content on its
  own registrable domain ([design.md](design.md#1-hosts-and-origins)); both are supported layouts.
- Access protects the app host and the private content hosts with two self-hosted applications whose policies admit
  only the owner. The API host and the public content hosts are not behind Access; where an application covers the
  whole zone, they have Bypass applications.
- D1 holds metadata; a private R2 bucket holds file bytes; a KV namespace holds OAuth clients, grants and tokens. The
  Worker runs on Workers Paid.
- The owner's machine runs the agents and the CLI; a credential lives there in an agent's configuration or token store,
  or in the CLI's environment or stored login.

**Out of scope:** a compromised Cloudflare account or platform, a compromised Access identity provider, a compromised
owner machine beyond the leak of a credential (R3), the owner acting against their own deployment, denial of service
that Cloudflare's own protection does not absorb, copies a browser or a person already downloaded, and the build and
dependency supply chain. TLS is assumed between all parties.

**Not built, on purpose:** rate limits, quotas, per-credential scopes, remembered OAuth consent, accounts or tenants,
content scanning, a CSP on artifact pages, and backups of file bytes or OAuth storage. The deployment has one owner,
and the threats are the three adversaries below, not untrusted users.

## Assets

| ID  | Asset                                                                            | Why it matters                                                                                  |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A1  | Private artifacts: files, titles, descriptions and version history               | The owner's work; agents may put private data in it                                             |
| A2  | Credentials: API tokens, OAuth access and refresh tokens, authorization codes    | A credential reads, publishes, makes public and deletes every artifact until revoked or expired |
| A7  | OAuth grants and registered clients (KV)                                         | A grant the owner did not approve, or one that cannot be revoked, gives lasting access          |
| A3  | The owner's Access session (`CF_Authorization` per host) and identity            | A content JWT opens every private artifact; an app JWT opens the gallery                        |
| A4  | Integrity of artifacts and their history                                         | What a URL shows is what an agent stored as that version                                        |
| A5  | The owner's other services and the reputation of the domains the deployment uses | Artifact and public pages sit next to them in the shared-domain layout                          |
| A6  | Cost: Workers requests and CPU, D1, R2, KV                                       | The owner pays                                                                                  |

## Adversaries

| ID  | Adversary                                                                                                                           | Capabilities                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | An outsider on the internet, including a website the owner visits                                                                   | Reaches every host and route with any method, header and body; makes the owner's browser load and embed URLs; registers OAuth clients with any name and redirect URI and sends the owner's browser to the consent page; holds no owner identity and no credential |
| R2  | A buggy or prompt-injected artifact page                                                                                            | Runs JavaScript at its artifact origin in the owner's browser, or a visitor's when public: requests, embeds, storage, service workers, cookies for its host and parent domain                                                                                     |
| R3  | A holder of a leaked credential (an API token, an OAuth access or refresh token), or an agent prompt-injected while holding its own | Calls every REST route or MCP tool of its credential's resource as that credential; with a refresh token, renews access until the grant is revoked or idle                                                                                                        |
| R4  | A party that learns an artifact URL                                                                                                 | Requests it; for a public artifact, that URL is the share link                                                                                                                                                                                                    |

## Entry points

| Entry point                                                                                                                      | Reached by                                                  | Authenticated by                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Gallery on the app host                                                                                                          | R1, R2                                                      | Access; the Worker verifies the JWT (ACC-1)                                                       |
| Private content hosts                                                                                                            | R1, R2, R4                                                  | Access; the Worker verifies the JWT (ACC-1)                                                       |
| Public content hosts                                                                                                             | R1, R2, R4                                                  | none; the artifact's public flag (PUB-1)                                                          |
| REST API on the API host, `/v1/grants` included                                                                                  | R1, R3                                                      | bearer credential (TOK-1)                                                                         |
| MCP endpoint `/mcp` on the API host                                                                                              | R1, R3                                                      | bearer credential (TOK-1) and the `Origin` rule (HOST-3)                                          |
| OAuth metadata on the API host: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` and `/v1` | R1                                                          | none: public by design, built from the configuration                                              |
| Client registration `/oauth/register` on the API host                                                                            | R1                                                          | none: a client record grants nothing without the owner's approval (OAUTH-1)                       |
| Token endpoint `/oauth/token` on the API host                                                                                    | R1, R3                                                      | a code with its PKCE verifier (OAUTH-2), or a refresh token (OAUTH-5)                             |
| Authorization and consent `/oauth/authorize` on the app host                                                                     | R1, R2                                                      | Access (ACC-1) and the consent transaction (OAUTH-1)                                              |
| Any other host or route that reaches the Worker                                                                                  | R1                                                          | none; answered 404 without storage (HOST-1)                                                       |
| CLI and the deployment script                                                                                                    | the owner                                                   | the token in the environment or the stored login; the owner's account                             |
| The CLI's sign-in callback on `127.0.0.1`                                                                                        | the owner's browser; other processes on the owner's machine | `state` and `iss`; the code is useless without the CLI's PKCE verifier; one callback, then closed |
| The `release` branch, deployed by Workers Builds                                                                                 | the owner, the release workflow                             | a ruleset that lets only the workflow's App update it, fast-forward to a release of `main`        |

## Invariants

### Hosts (HOST)

- **HOST-1: a request is classified by exact host.** The host is the app host, the API host, or a 26-character ID
  followed by exactly the content or public suffix; anything else answers 404 without reading D1 or R2. `workers_dev`
  and `preview_urls` are false. _Enforced (main)_ in `src/hosts.ts`. Pinned by behavior (`src/config.test.ts`,
  `src/routing.test.ts`: hosts with an extra label, uppercase letters, prefixes of 25 and 27 characters, a port; no D1
  or R2 call) and source check (`src/source.test.ts`: `wrangler.jsonc`). Of the OAuth paths, only the API host's
  metadata, token and registration paths reach the OAuth library, the app host answers the others with 404, and a
  content or public host answers them as any path: _Enforced (main)_ in `src/index.ts`, `src/oauth.ts`, pinned by
  behavior (`src/oauth.test.ts`: every OAuth path on each host class with the library's entry points spied on; an
  artifact's files at `oauth/token` and `.well-known/oauth-authorization-server` on its content and public hosts)
  (PL-43). The app host's `/oauth/authorize` reaches the library's helpers, and nothing else of the app host does:
  _Enforced (main)_ in `src/index.ts`, `src/consent.ts`, pinned by the same test.
- **HOST-2: a configuration that would weaken a boundary is refused.** Refused: a public suffix that ends with the
  content suffix (the content Access wildcard would cover public hosts), an app or API host under either suffix, a
  suffix that makes an artifact label longer than 63 characters, and a mix of `localhost` and other hosts. The Worker
  answers 503 `unavailable`; the deployment script refuses the same values with the same parser. _Enforced (main)_ in
  `src/config.ts`, `scripts/deploy-config.ts`. Pinned by behavior (`src/config.test.ts`: one test per refusal;
  `src/routing.test.ts`: 503 without storage; `scripts/deploy.test.ts`: each refusal through the deployment script).
- **HOST-3: `/mcp` refuses a foreign `Origin`.** A request that carries an `Origin` other than the API host's origin
  answers 403 before the MCP handler; agents send none. _Enforced (main)_ in `src/mcp.ts`. Pinned by behavior
  (`src/mcp.test.ts`: a foreign origin, `null`, and the API host with another scheme or port answer 403 without D1 or
  R2; the API host's origin and a request without `Origin` are served; a missing token answers 401 first).

### Access (ACC)

- **ACC-1: the gallery and private content are served only with a verified Access JWT.** The Worker reads
  `Cf-Access-Jwt-Assertion` (never a cookie) and verifies it with jose: RS256 only, the team domain's issuer, the
  audience of the host's class (app or content), `exp` required, 60 s clock tolerance, a key set reused for at most 7
  days. An invalid JWT answers 403; a key set that cannot be fetched within 5 s answers 503 `unavailable`; both log a
  reason code only. _Enforced (main)_ in `src/access.ts`. Pinned by behavior (`src/access.test.ts`,
  `src/routing.test.ts`; a local key set: missing JWT, bad signature, other issuer, the other class's audience, missing
  `exp`, expired and the tolerance edges, an algorithm other than RS256, an unknown `kid` that refreshes the set once,
  an unreachable key endpoint, a valid JWT sent only as a cookie). **Gap:** the production durations (a key set reused
  for 7 days, a 5 s key fetch) are checked by review, not by tests, which substitute short ones. `/oauth/authorize` is
  verified with the app audience like the gallery, its `POST` included: _Enforced (main)_ in `src/index.ts`, pinned by
  behavior (`src/consent.test.ts`: `GET` and `POST` without a JWT and with the content audience's answer 403 before
  the library) (PL-37).
- **ACC-2: Access verification is skipped only for a `localhost` configuration.** Every configured host must be a
  `localhost` name; no variable turns verification off, and the deployment script refuses `localhost` hosts and ports.
  OAuth is off there too, so no consent page runs without Access: every OAuth path answers 404. _Enforced (main)_ in
  `src/config.ts`, `src/index.ts`, `scripts/deploy-config.ts`. Pinned by behavior (`src/routing.test.ts`:
  production-shaped hosts without a JWT answer 403, and in a `localhost` configuration every OAuth path answers 404
  with any method (PL-47); `src/config.test.ts`: a mix of `localhost` and other hosts is refused;
  `scripts/deploy.test.ts`: a `localhost` name and a port in each host variable are refused).
- **ACC-3: the Access applications admit only the owner, and their cookie is HttpOnly.** The content application covers
  exactly `*` + the content suffix. HttpOnly is set explicitly because the documented default is inconsistent; without
  it, artifact JavaScript could read its host's JWT, which names the application's audience rather than the host and so
  opens every private artifact. _Planned._ Pinned by deployed check (another identity is denied; `document.cookie` on an
  artifact host shows no `CF_Authorization`; a public host does not redirect to Access).

### Credentials (TOK)

- **TOK-1: every request to `/v1/` and `/mcp` needs a valid bearer credential.** An OAuth access token is valid on the
  resource it was issued for until it expires or its grant is revoked (OAUTH-3, OAUTH-5); an API token is valid when
  the SHA-256 of the presented token equals an entry of `API_TOKENS`, compared with every entry in constant time. A
  credential of the library's three-part form is checked by the library only, any other against `API_TOKENS` only.
  Neither check reads D1 or R2, and the OAuth check reads two KV records, the token's and its grant's revocation
  record (OAUTH-5); a failure answers 401 `unauthorized`. The
  OAuth endpoints and metadata documents on the API host take no credential. An `API_TOKENS` that is missing or `{}`
  refuses every API token, and a malformed one answers 503. _Enforced (main)_ for API tokens in `src/tokens.ts` and
  `src/config.ts`, and for the open authorization server endpoints in `src/index.ts`; _Planned (OAuth)_ for access
  tokens and the protected resource metadata. Pinned by behavior
  (`src/routing.test.ts`: each REST route and `/mcp`: no header, another scheme, unknown and removed tokens, nothing
  changed; every token refused while `API_TOKENS` is missing or `{}`, and 503 on every host for a malformed one
  (PL-46); planned: PL-40) and review (the constant-time comparison). **Changed for OAuth:** "every request to the API host" became "every request to `/v1/`
  and `/mcp`", because discovery, registration and the token exchange must answer before a client holds a credential
  (design.md, AC-14). They reach KV only, and a client record or a code grants nothing without the owner's approval
  (OAUTH-1), so no artifact operation is open.
- **TOK-2: a credential is never stored in clear, logged or handed to the MCP SDK, and only the token endpoint returns
  one.** `API_TOKENS` holds hashes; KV holds OAuth credentials as hashes (OAUTH-4); D1 holds publisher names; no
  response echoes the `Authorization` header; the token endpoint returns tokens only to the client presenting a code
  with its verifier or a refresh token; the per-request MCP factory captures the publisher name, and the request it
  serves has no `Authorization` header. _Enforced (main)_ for API tokens in `src/tokens.ts`, `src/mcp.ts`; _Planned
  (OAuth)_ for OAuth credentials. Pinned by log redaction and behavior (`src/log-redaction.test.ts`: REST and `/mcp`
  responses hold no marker token; `src/mcp.test.ts`: for a 2025-era and a 2026-07-28 client, every request and factory
  context the SDK receives carries no `Authorization` header, token or `authInfo`, and versions record the token name;
  planned: PL-42, PL-45). **Changed for OAuth:** OAuth needs a token endpoint that returns tokens and a record per
  token to check and revoke it. Hashing keeps what TOK-2 protected: reading KV, like reading the secret, yields no
  usable credential.
- **TOK-3: every version and every change records its publisher.** A version stores `published_by`, the publisher name
  of its credential (an API token's name, or the name the owner gave a grant); create, publish, public, archive and
  delete changes log the publisher name and, for an OAuth credential, the grant's ID, since names may repeat across
  grants. _Enforced (main)_ for API tokens in `src/operations.ts`, and for the name a grant receives in
  `src/consent.ts`: the consent form takes only a name of the form `[a-z0-9-]{1,32}`, keeps it in the grant's props
  and logs it with the grant's ID in `grant.created`; _Planned (OAuth)_ for versions and changes made with a grant.
  Pinned by behavior and log redaction (`src/publish.test.ts`; `src/consent.test.ts`: a name of the wrong form creates
  no grant and keeps the transaction, a corrected one succeeds (PL-39); planned: PL-7).

### Origin isolation (ISO)

- **ISO-1: an artifact host serves only that artifact, and an ID is never reused.** File lookups are keyed by the ID
  from the host; a deleted artifact keeps a tombstone row, and the primary key refuses an ID that existed, so no new
  artifact inherits an old origin's storage or service worker. _Enforced (main)_ in `src/db.ts`. Pinned by behavior
  (`src/serve.test.ts`: two artifacts with the same path and different bytes each serve their own; create with a
  generator stubbed to a deleted ID is refused).
- **ISO-2: private content cannot be read or loaded as a subresource from another origin.** No host sends
  `Access-Control-Allow-*`, and no preflight succeeds: `OPTIONS` answers 405 on every route and 404 where no route is,
  so a cross-origin `fetch` cannot read a response. Every response
  of a private content host and of the app host carries `Cross-Origin-Resource-Policy: same-origin` (200, 304, 308,
  404), so another origin's `<script>`, `<img>`, `<link>` or media element cannot load it with the owner's cookie and
  observe it. CORP does not govern navigation: another origin can still frame a private page, which shows it to the
  owner without giving the framer its content; for one owner, no framing policy is added. Public hosts do not send
  CORP: their content needs no credential, so loading it reveals nothing a direct request does not.
  _Enforced (main)_ in `src/serve.ts`, `src/gallery/route.ts`. Pinned by behavior (`src/serve.test.ts`,
  `src/routing.test.ts`, `src/gallery/gallery.test.ts`: every route and status, both host classes) and deployed check
  (design AC-8: artifact A's `<script src>` to artifact B fails, B loads its own). **Gap:** the deployed check has not
  run. The OAuth library adds CORS headers for browser clients; the router removes them, and `OPTIONS` answers 405 on
  every API route before authentication, and 404 on a path no route takes: _Enforced (main)_ in `src/oauth.ts`,
  `src/index.ts`, pinned by behavior (`src/oauth.test.ts`: OAuth answers to requests with an `Origin`; `OPTIONS` on
  each API route, with and without a token, and on a path no route takes) (PL-43).
- **ISO-3: browsers can only read artifacts.** Content hosts answer `GET` and `HEAD` only, and so does the app host
  except `/oauth/authorize`, which answers `GET` and `POST` only; that `POST` creates or refuses a grant under OAUTH-1
  and changes no artifact. Every artifact change is on the API host with a bearer credential, so no request
  authenticated by a cookie changes an artifact. _Enforced (main)_ in `src/serve.ts`, and for the authorize path in
  `src/index.ts`, `src/consent.ts`. Pinned by behavior (`src/routing.test.ts`; `src/consent.test.ts`: `HEAD`, `PUT`,
  `DELETE`, `PATCH` and `OPTIONS` on `/oauth/authorize` answer 405 before Access and storage, and the form's `POST`
  under OAUTH-1) (PL-11, PL-37). **Changed for OAuth:** signing in needs
  the owner's approval in a browser (P3). What ISO-3 kept from artifact pages holds: the one browser write needs the
  owner's Access session, a handle only the consent page shows, and the browser's `__Host-` binding cookie.
- **ISO-4: the Worker sets one cookie, the consent binding, and decides nothing else on a cookie.** The binding is
  the library's `__Host-` cookie, set by `GET /oauth/authorize` and cleared when its transaction is used; it ties a
  consent transaction to the browser that opened it and authenticates nothing (ACC-1 still reads the JWT header). No
  other route sets a cookie. _Enforced (main)_ in `src/consent.ts`, which takes only the binding from the library's
  headers. Pinned by behavior (`src/routing.test.ts`, `src/serve.test.ts`: no `Set-Cookie` on any route;
  `src/access.test.ts`: a valid Access JWT sent only as a cookie is refused, ACC-1; `src/consent.test.ts`: the page
  sets one `__Host-` binding, `Secure; HttpOnly; SameSite=Lax`, the answers that use it clear it, and no other answer
  of the endpoint sets one) (PL-11, PL-37). **Changed for OAuth:** the cookie is the library's
  protection of the consent form against cross-site requests. `__Host-` keeps what ISO-4 protected in the
  shared-domain layout: no other host, artifact pages included, can set or replace it.
- **ISO-5: the app host runs no supplied markup.** Artifact titles, descriptions, paths and every other value, and
  on the consent page every value a client supplied (its name, URI and redirect URI), are escaped by the one template
  that builds the pages; every app-host response's `Content-Security-Policy`, refusals and failures included, forbids
  scripts and framing, and forms except the consent page's, whose `form-action` admits the page and the client's
  redirect origin only. _Enforced (main)_ in `src/gallery/html.ts`, `src/gallery/route.ts`, `src/index.ts`, and for
  the consent page in `src/gallery/pages.ts`, `src/consent.ts`. Pinned by behavior (`src/gallery/gallery.test.ts`:
  markup and attribute breakouts in titles, descriptions, paths and content types on every page; the header on every
  status the app host answers; `src/consent.test.ts`: markup in a client's name, URI, redirect path and `state`; the
  page's policy with a loopback and an `https` origin in `form-action`, `form-action 'none'` on the endpoint's other
  answers, and redirect origins of another form refused before the page (PL-38); `src/gallery/reference.test.ts`: the
  consent pages' markup). **Changed for OAuth:** the consent form must post and then send the browser to
  the client. The origin added to `form-action` is the one the page shows the owner, and only of the forms design.md
  section 7 lists.

### Serving (SRV)

- **SRV-1: content responses do not reinterpret bytes or leak the host.** Each carries the stored `Content-Type`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. _Enforced (main)_ in `src/serve.ts`. Pinned by
  behavior (`src/serve.test.ts`).
- **SRV-2: a request path selects a file of the requested artifact and version only.** The Worker resolves the pathname
  it receives: one strict percent-decoding per segment, an encoded `/` refused, lookup inside the selected version's
  file list. _Enforced (main)_ in `src/paths.ts`. Pinned by behavior (`src/paths.test.ts`: decoder tests over strings;
  `src/serve.test.ts`: Worker tests over `Request` objects asserting the selected version and file).
- **SRV-3: a 304 never skips a check.** Access (ACC-1), the public flag (PUB-1) and the artifact's existence are checked
  before `If-None-Match` is compared, for latest and pinned versions alike, and every content response revalidates
  (`no-cache`). _Enforced (main)_ in `src/serve.ts`. Pinned by behavior (`src/serve.test.ts`: a matching
  `If-None-Match` after the artifact was made private or deleted answers 404; without a valid JWT, 403; the same for
  the icon an artifact without `favicon.ico` is answered with).

### Public links (PUB)

- **PUB-1: a public host serves an artifact only while it is public, and then every version.** The flag is read on
  every request; a private, deleted or unknown artifact answers the same 404. Making an artifact public exposes its
  latest and all pinned versions. A public host never serves the gallery or the API. _Enforced (main)_ in
  `src/serve.ts`. Pinned by behavior (`src/serve.test.ts`: the three 404s are identical; pinned versions are served
  while public; the next request after making it private answers 404).
- **PUB-2: only the API changes the flag**, with a token (TOK-1); the flag is off when an artifact is created.
  _Enforced (main)._ Pinned by behavior (`src/serve.test.ts`, `src/routing.test.ts`).

### Versions (VER)

- **VER-1: a stored version never changes.** No operation rewrites a version's rows; an object's key is the SHA-256
  the Worker computed from its bytes. _Enforced (main)_ in `src/operations.ts`, `src/objects.ts`. Pinned by behavior
  (`src/publish.test.ts`: after publishes that share and change files, earlier versions' rows and bytes are unchanged
  and every key matches its bytes).
- **VER-2: a publish becomes visible only through its single commit.** Bytes are uploaded first; the version appears
  in one D1 batch, which rolls back as a whole. A failure before the commit, or a commit that rolls back, leaves no
  version. The commit has no timeout of its own, since a timed-out commit could still apply; when a disconnect cancels
  the request, the outcome is learned by reading, as [design.md](design.md#publish) describes. _Enforced (main)_ in
  `src/operations.ts`, `src/db.ts`. Pinned by behavior (`src/publish.test.ts`: a failure at each upload, an upload
  timeout, a failing batch).
- **VER-3: an update commits only on top of the latest version.** A `base_version` that is not the latest, or an
  artifact deleted meanwhile, commits nothing. _Enforced (main)_ in `src/operations.ts`, `src/db.ts`. Pinned by behavior
  (`src/publish.test.ts`: stale base; two concurrent updates from one base commit exactly one; a delete between upload
  and commit).
- **VER-4: objects belong to one artifact, and deletion is logical first.** Keys are `a/<id>/<sha256>`; no version
  references another artifact's object. Deleting commits the tombstone and removes the rows at once, so every URL
  answers 404; removing the prefix's objects follows, best effort, and a repeated delete retries it. _Enforced (main)_
  in `src/operations.ts`, `src/objects.ts`. Pinned by behavior (`src/rest.test.ts`: URLs 404 right after delete; the
  prefix is empty after a cleanup that succeeded; a failed cleanup completes on the repeated delete).

### Resources (RES)

- **RES-1: input is bounded before it is used.** The bounds of [design.md](design.md#limits), each in its unit;
  request bodies are counted while they are read. _Enforced (main)_ in `src/body.ts`, `src/schemas.ts`, `src/paths.ts`,
  `src/mcp.ts` (the `read_file` bound; the MCP request bound is the SDK's default, which counts the body as it reads
  it). Pinned by behavior (`src/schemas.test.ts`, `src/paths.test.ts`, `src/publish.test.ts`, `src/mcp.test.ts`: at and
  one past each bound; a chunked body without `Content-Length`; a `read_file` over the bound reads no object). The
  OAuth token and registration bodies are counted before the library reads them: _Enforced (main)_ in `src/oauth.ts`,
  pinned by behavior (`src/oauth.test.ts`: at and one past each bound, with and without `Content-Length`, the library
  not called) (PL-44). The consent form, at most 4 KiB, is counted before it is parsed: _Enforced (main)_ in
  `src/consent.ts`, pinned by behavior (`src/consent.test.ts`: at and one past the bound).
- **RES-2: waits are bounded where the outcome stays known.** Fetching Access keys, each R2 call and each D1 read have a
  timeout and answer 503 `unavailable`; a publish that times out before its commit leaves no version. The D1 commit
  has none: a timed-out commit could still apply. _Enforced (main)_ in `src/timeout.ts`, `src/objects.ts`, `src/db.ts`,
  `src/access.ts`. Pinned by behavior (`src/access.test.ts`, `src/publish.test.ts`: slow key endpoint, R2 and D1
  reads; a slow commit still applies; `src/mcp.test.ts`: `read_file` reads an object's body under the R2 timeout and
  cancels a body that stalls). **Gap:** the production waits (5 s for Access keys, 30 s per R2 call, 10 s per D1
  read) are checked by review, not by tests, which substitute short ones. The KV read of the revocation record before
  a token request waits 10 s and answers 503: _Enforced (main)_ in `src/revocation.ts`, `src/oauth.ts`, pinned by
  behavior (`src/oauth.test.ts`, `src/revocation.test.ts`: a read that fails or never answers). The library's KV calls
  on the token, registration and authorize paths, and a revocation's writes, have no timeout of ours, since a write
  that timed out could still apply; the library bounds a client document fetch at 10 s (OAUTH-6). The grant listing
  an approval reads to replace a client's grants waits 10 s per page and answers the 503 error page: _Enforced (main)_
  in `src/consent.ts`, pinned by behavior (`src/consent.test.ts`: a listing that fails or never answers). The KV reads
  of a credential check and of `/v1/grants` wait 10 s and answer 503: _Planned (OAuth)_ (PL-40).

### Data (DATA)

- **DATA-1: logs carry no secret and no artifact content.** In the Worker's own code only `logEvent` writes to the
  console, with fields from closed sets (event names, reason codes, error classes, publisher names, grant IDs,
  artifact IDs, version numbers, counts): never a credential, an `Authorization` header, an Access JWT or cookie, a
  code, a PKCE verifier, a consent handle, a client's name, file bytes, a title, a description or a path. The OAuth
  library's error logging is replaced by `oauth.refused` with closed codes. Two lines of the library's own have no
  hook to replace them (design.md section 7): a client document that cannot be fetched or checked (the client ID as
  sent and the failure's message, which can quote the document's `client_id` and authentication methods) and a failed
  renewal of a registered client (its generated ID and the KV error). They carry only what the caller or a document's
  publisher chose: the first logs the client ID as the caller sent it, so whatever the caller put in its own
  identifier, a password in its userinfo included, reaches the logs. Neither carries another party's secret or
  private content: the library fetches the document without a credential from a public address, where a private host
  answers with Access's sign-in. Invocation logs are off. _Enforced (main)_ in
  `src/log.ts`, for the authorization server's paths in `src/oauth.ts`, and for the consent page in `src/consent.ts`;
  _Planned (OAuth)_ for OAuth credentials on `/mcp` and `/v1/`. Pinned by log redaction (`src/log-redaction.test.ts`:
  every route and failure path, `/mcp` and its SDK refusals included; `src/oauth.test.ts`: the metadata,
  registration and token endpoints, their refusals, a revocation and KV and fetch failures, every `console` method
  captured, with markers in codes, tokens, verifiers, client names, client-ID paths, queries and userinfo, a client
  document's fields and thrown errors, each appearing only where those two lines put it, and the `onError` hook
  logging `oauth.refused` only (PL-45); `src/consent.test.ts`: every outcome of the authorization endpoint, with
  markers in a client's name and URI, a redirect path, `state`, a consent handle and cookie, a code, a form value and
  a KV error's message, none appearing) and source check (`src/source.test.ts`: `console` only in the logging module;
  `wrangler.jsonc`). **Gap:** the gallery's routes are not among the redaction
  markers yet. **Changed for OAuth:** "only `logEvent`" covers the Worker's own sources, since the dependency's two
  lines are bounded here rather than suppressed by patching it, and the first can quote a public artifact's values
  when a client ID names it or redirects to it. What DATA-1 protected holds: no credential or private content reaches
  the logs, and a public artifact's values are open to anyone with its link.
- **DATA-2: deployment values stay out of the repository.** `wrangler.jsonc` sets no variable, route or identifier,
  and binds `OAUTH_KV` without an ID; the deployment values live in the gitignored `wrangler.deploy.jsonc` or a Workers
  Builds variable, the committed example holds placeholders only, and `API_TOKENS` is a secret. _Enforced (main)_ in
  `wrangler.jsonc`, `wrangler.deploy.example.jsonc`, `scripts/deploy-config.ts`, `scripts/deploy-run.ts`. Pinned by
  source check (`src/source.test.ts`: `wrangler.jsonc` and the example) and behavior (`scripts/deploy.test.ts`: the
  deployment values may not set `API_TOKENS` or a key of `wrangler.jsonc`, and the namespace's ID, 32 lowercase
  hexadecimal characters, must be one the account lists before the migrations run (PL-48)).

### OAuth (OAUTH)

Decided in [design.md](design.md#7-auth) section 7. Each states which part is _Enforced (main)_; the rest is
_Planned (OAuth)_.

- **OAUTH-1: only the owner creates a grant.** A grant is created only by `POST /oauth/authorize` on the app host,
  after ACC-1 with the app audience, with the handle of a consent transaction that the same browser opened (its
  `__Host-` binding cookie), within 10 minutes and once. Consent is never remembered, and the consent page cannot be
  framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). _Enforced (main)_ in `src/index.ts`, `src/consent.ts`,
  with the library's consent helpers. Pinned by behavior (`src/consent.test.ts`: no JWT, the content audience, no
  cookie or another transaction's, a used or expired handle, Deny; two `GET`s create no grant; the page shown again
  after an approval) (PL-37) and deployed check (AC-19: another identity is denied).
- **OAUTH-2: a code goes only to a redirect URI the client registered, outside this deployment.** The redirect URI
  matches a registered one exactly, a loopback one on any port; one on a host of this deployment is refused before the
  consent page, since an artifact page there could read the code. Every client must send an S256 PKCE challenge: the
  library requires one only from clients that authenticate with `none`, so the router requires it from the rest, and
  `plain` is refused. Every redirect carries `state` and `iss`; the consent page's `form-action` admits the redirect
  origin only. _Enforced (main)_ in `src/consent.ts`, with the library's checks of the registered redirect URIs and of
  the verifier at the code exchange. Pinned by behavior (`src/consent.test.ts`: redirect URIs on each host class
  refused with an error page even where the library would redirect an error; an unregistered host form or path; another
  loopback port accepted; public and confidential clients, without a challenge, with `plain`, with a challenge the
  verifier does not match (PL-36); `state` and `iss` on every redirect; `form-action` (PL-38)).
- **OAUTH-3: an access token works only on its resource.** Every grant and token names `<API origin>/mcp` or
  `<API origin>/v1`; a token is refused on the other, and refreshing keeps the grant's resource. Pinned by behavior
  (PL-40; PL-34 for a request without `resource`).
- **OAUTH-4: KV holds no credential in clear.** Access and refresh tokens, codes, client secrets and consent handles
  are stored as hashes, a grant's props encrypted under keys its tokens wrap, a consent transaction encrypted under a
  key derived from its handle, and a PKCE challenge in place of its verifier. A grant's listing metadata (publisher
  name, client name, redirect host) is not a credential and is stored in clear. Pinned by behavior (PL-42: while a
  pending consent, an unexchanged code, issued tokens and a confidential client's registration are each live and
  asserted to exist, no key or value holds its credential).
- **OAUTH-5: revoking a grant ends it for good.** `DELETE /v1/grants/{id}`, RFC 7009 with the grant's refresh token,
  and a new approval for the same client and resource (for a CIMD client, from the same redirect URI) delete the grant
  and its tokens through the library's `revokeGrant`, the only code that deletes a grant. The library reaches KV
  through a forwarding wrapper that writes the grant's revocation record before the grant's deletion and fails the
  deletion when that write fails, so no revocation succeeds without a record; a failure answers 503, never a silent
  success. The router refuses every use of a grant with a record: an access token after `validateToken`, a code or
  refresh token before the library's token endpoint. A refresh that read the grant before its deletion can still
  write it back, since the library reads and writes the grant without a condition, but that write follows the record
  and its tokens meet it. No library path reads, writes or deletes a `revoked:` key, and records never expire. KV's
  propagation delays the effect in other locations (accepted risks); RFC 7009 allows that delay ("there could be a
  propagation delay", section 2.1). RFC 7009 with an access token revokes that token only. _Enforced (main)_ for the
  wrapper and the token endpoint in `src/revocation.ts`, `src/oauth.ts`, pinned by behavior (`src/revocation.test.ts`:
  the record before the deletion, a failed write failing it; `src/oauth.test.ts`: a revoked grant's code and refresh
  token refused, to a client that authenticated, as a grant that is gone, a refresh's and a code exchange's write-back
  after the revocation, RFC 7009 with each token, injected failures of the record's write and of the deletion); and
  for approval in `src/consent.ts`, pinned by behavior (`src/consent.test.ts`: the client's grant for the resource
  replaced and its tokens refused, its other resource and other clients kept, a CIMD client's grant replaced only from
  the same redirect URI; a refresh's write-back after the replacement refused; injected failures of the listing, the
  record's write and the deletion answering 503 without a code). _Planned (OAuth)_ for `/v1/grants` and access
  tokens. Pinned by behavior (PL-41: for each path, barriers
  between a refresh's and a code exchange's read and write of the grant; injected failures of the record's write and
  of the deletion) and deployed check (AC-20, the delay measured).
- **OAUTH-6: client documents are fetched only from public addresses and bounded, and a client on this deployment's
  hosts gets no consent page.** The compatibility flag `global_fetch_strictly_public` keeps the library's CIMD fetches
  on public addresses, the library bounds a document at 5 KB and 10 s, and the authorize endpoint refuses a client ID
  on a host of this deployment before any fetch. The token endpoint may still fetch such a document, since the
  library authenticates a CIMD client there; it decides nothing, because no code or grant can exist for a client the
  authorize endpoint refused. A host of this deployment is the app or API host, or any name that ends in a content
  or public suffix, as the deployment's routes match them. _Enforced (main)_ in `wrangler.jsonc` and
  `src/consent.ts`. Pinned by behavior (`src/consent.test.ts`: a stubbed document on an outside host fetched and its
  domain shown; a client ID on each host class, in upper case, with a trailing dot or a port, refused with no fetch;
  an unreachable or invalid document answering an error page) (PL-35) and source check (`src/source.test.ts`:
  `wrangler.jsonc` sets the flag).

## IDs to check by change type

- **Routing or configuration:** HOST-1 to HOST-3, ACC-2, ISO-2, ISO-3, DATA-2.
- **Access or credentials:** ACC-1 to ACC-3, TOK-1 to TOK-3.
- **OAuth (the router's OAuth paths, the consent page, the library's version):** HOST-1, ACC-1, TOK-1 to TOK-3, ISO-2
  to ISO-5, RES-1, RES-2, DATA-1, OAUTH-1 to OAUTH-6. An upgrade of the library reads its changelog against these.
- **Serving:** ISO-1, ISO-2, SRV-1 to SRV-3, PUB-1, RES-2.
- **Publish, update, archive or delete:** VER-1 to VER-4, RES-1, RES-2, TOK-3.
- **Gallery or the consent page:** ISO-2 to ISO-5, OAUTH-1, OAUTH-2.
- **Logging:** DATA-1; extend the redaction markers to the new path.

## Accepted risks

| Risk                                                                                                                                                                                                                                                                                                                                     | Why accepted                                                                                                                                                                                                                                                                                                                                                        | Holds while, or revisit when                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A leaked credential (R3) reads, publishes, makes public and deletes every artifact until revoked or expired; deleted bytes cannot be recovered                                                                                                                                                                                           | One owner; one credential per agent, revoked by editing a secret or revoking a grant; versions and logs name the publisher, and the grant; artifacts are agent output that can be produced again                                                                                                                                                                    | Revisit when an artifact is the only copy of something, or a credential goes to an agent the owner does not run                                                                                              |
| No scopes: an agent prompt-injected while holding its own credential can delete or make public, and a grant covers a whole resource                                                                                                                                                                                                      | Scopes would need a policy model for one person. Whether a client asks before a tool call is the owner's client configuration, not a control here                                                                                                                                                                                                                   | Revisit when an agent runs unattended with these tools                                                                                                                                                       |
| An artifact page (R2) can send requests, not read answers or load them as subresources, to other artifact hosts, the gallery and the API, with the owner's cookies where the browser sends them                                                                                                                                          | Every such target only reads artifacts (ISO-3); the consent form also needs a handle no other origin can read and a `__Host-` cookie (OAUTH-1); nothing can be read or loaded as a subresource across origins (ISO-2)                                                                                                                                               | Holds while ISO-2, ISO-3 and OAUTH-1 hold                                                                                                                                                                    |
| An artifact page can read the owner's Access identity (email, name) if Access answers its identity endpoint on artifact hosts; the documentation describes it on the team domain only                                                                                                                                                    | It is identity, not a credential (the JWT stays HttpOnly, ACC-3)                                                                                                                                                                                                                                                                                                    | Revisit when the identity carries sensitive claims                                                                                                                                                           |
| A page's own browser state (storage, service worker) spans all its versions and can change what an old version shows in the owner's browser                                                                                                                                                                                              | Versions share the origin by design; stored bytes are immutable (VER-1); clearing site data resets the state                                                                                                                                                                                                                                                        | Revisit when versions must be inspected independently of the page's own code                                                                                                                                 |
| Shared-domain layout: an artifact page can set cookies for the owner's domain, which the owner's other services then receive, and its requests to them are same-site; it can break Access sign-in on the app host until cookies are cleared; a page published with a leaked token sits on the owner's domain (reputation, Safe Browsing) | A supported layout the owner chooses; this deployment's own protections rely on neither cookies set by siblings nor `SameSite` (ACC-1, TOK-1, ISO-2 to ISO-4)                                                                                                                                                                                                       | Holds while the owner's other services on that domain do not trust cookies a sibling host can set and do not rely on `SameSite` alone against cross-site requests; otherwise use the dedicated-domain layout |
| Making an artifact public exposes every version, including ones published before                                                                                                                                                                                                                                                         | One flag per artifact keeps sharing simple; the owner decides per artifact                                                                                                                                                                                                                                                                                          | Revisit when single versions must be shared                                                                                                                                                                  |
| A public artifact's host, its share link, reaches parties its page contacts (the `Origin` of CORS requests, anything the page sends)                                                                                                                                                                                                     | Public means published; the 130-bit ID protects against guessing, not against the page disclosing itself                                                                                                                                                                                                                                                            | Revisit when share links must be revocable or expire independently of the flag                                                                                                                               |
| Objects that no version references remain after a failed or raced publish, and until a failed cleanup is retried                                                                                                                                                                                                                         | They are never served (VER-2) and cost storage only                                                                                                                                                                                                                                                                                                                 | Revisit when their storage becomes noticeable                                                                                                                                                                |
| Outsiders (R1) can make the Worker answer 401, 403 and 404 at the owner's expense, and fetch a client document of at most 5 KB per token request that names a URL as its client                                                                                                                                                          | Each refusal comes before any D1 or R2 call (HOST-1, ACC-1, TOK-1); a credential of the OAuth form costs at most two KV reads; the authorize endpoint is behind Access; Cloudflare absorbs volumetric attacks                                                                                                                                                       | Revisit when unauthenticated traffic costs noticeably (A6)                                                                                                                                                   |
| Revocation is not immediate: until a grant's revocation record reaches a location, 60 s or more, the grant's tokens still work there, and a refresh there can write the grant back and receive tokens; a code, a refresh token or a consent transaction used twice at nearly the same moment can be accepted twice                       | KV is eventually consistent and has no atomic read-and-delete, as the library states. The record makes the delay the only effect: no library path removes it, and every later use of the grant meets it. A code needs its PKCE verifier, a consent transaction its browser's cookie, and a doubled refresh stays inside one grant, which revocation ends; one owner | Revisit when a minute of access after revocation matters; meanwhile binding a new namespace (operations.md) ends every grant at once                                                                         |
| Anyone can register an OAuth client (DCR); each registration is a KV record kept 90 days                                                                                                                                                                                                                                                 | A client gets nothing without the owner's approval (OAUTH-1); Gemini CLI and the CLI need DCR                                                                                                                                                                                                                                                                       | Revisit when registrations cost noticeably (A6): then turn DCR off and pre-register those two clients                                                                                                        |
| Consent phishing: a client of anyone's making, named as it likes and with its own redirect URI, can ask the owner to approve it; an approval gives full access to one resource                                                                                                                                                           | Only the owner can approve (Access); the page says a DCR name is unverified, shows the redirect host, warns for a loopback one, and is never remembered; this deployment's hosts are refused (OAUTH-2, OAUTH-6)                                                                                                                                                     | Holds while the owner approves only a sign-in they just started; revisit when others' clients need access, with an allowlist of redirect hosts                                                               |
| A sliding grant has no absolute maximum: a refresh token used at least every 30 days keeps access, and the previous refresh token stays valid until its successor is first used                                                                                                                                                          | The owner's clients refresh daily, and a fixed lifetime would mean a monthly consent for each; rotation makes parallel use fail at a refresh; grants are listed with their client and redirect host and revoked one by one                                                                                                                                          | Revisit when a grant goes to a machine the owner does not control: then set a fixed lifetime                                                                                                                 |
| Any credential the API accepts can list and revoke every grant (`/v1/grants`)                                                                                                                                                                                                                                                            | Granting still needs the owner (OAUTH-1); a credential that can delete every artifact gains little from revoking a grant, and a revoked client signs in again                                                                                                                                                                                                       | Revisit when credentials get scopes                                                                                                                                                                          |
| The CLI keeps its OAuth tokens in a file only the owner's user can read, on macOS and Linux                                                                                                                                                                                                                                              | The same exposure as `ARTIFACTS_TOKEN` in a shell profile; a compromised owner machine is out of scope; the CLI refuses a file others can read or write; Windows has no file modes to check, so the CLI stores no login there                                                                                                                                       | Revisit when the CLI runs on a shared machine: then use the system's keychain                                                                                                                                |
| The OAuth library logs a client ID with the failure's message when its document cannot be fetched or checked; the request's sender or the document's publisher chooses both, and a client ID that names or redirects to a public artifact can put that artifact's `client_id` and method values in the line                              | No credential or private content can reach the line (DATA-1); a public artifact's values are open to anyone with its link; patching the dependency to silence it would be ours to maintain                                                                                                                                                                          | Revisit when logs feed automation or are shared beyond the owner, or the library offers a logging hook                                                                                                       |

## How to use

- **Changes** list the invariant IDs they touch and the status changes they make to this file.
- **Tests** name the invariant in the test name or a comment (for example `// ISO-2`), so a search for the ID shows its
  coverage.
