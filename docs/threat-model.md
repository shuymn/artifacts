# Threat model

What `artifacts` protects, from whom, and the security invariants the code must keep, by ID (for example `ISO-2`). It
covers security only; correctness and design are in [design.md](design.md), libraries and patterns in
[decisions.md](decisions.md).

**Keep it current.** A change that adds an entry point, asset, trust boundary or accepted risk, or changes an
invariant's status, updates this file. IDs are never reused: an invariant that no longer applies is marked retired
with the reason.

## Status and pinning

**Enforced (main):** the cited source and test exist on `main`. **Planned (first release):** not implemented; required
before the first release ships. Every invariant below is _Planned (first release)_. A **Gap** note names a part no test
pins yet; that part does not count as enforced.

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

- One owner deploys and uses a deployment; agents act for the owner with their own tokens.
- One Worker serves the app host (the gallery), the API host (REST and MCP), a host per artifact for private content,
  and a host per artifact for public content. Hosts sit under one domain the owner already uses or put content on its
  own registrable domain ([design.md](design.md#1-hosts-and-origins)); both are supported layouts.
- Access protects the app host and the private content hosts with two self-hosted applications whose policies admit
  only the owner. The API host and the public content hosts are not behind Access.
- D1 holds metadata; a private R2 bucket holds file bytes. The Worker runs on Workers Paid.
- The owner's machine runs the agents and the CLI; a token lives in an agent's or the CLI's configuration there.

**Out of scope:** a compromised Cloudflare account or platform, a compromised Access identity provider, a compromised
owner machine beyond the leak of a token (R3), the owner acting against their own deployment, denial of service that
Cloudflare's own protection does not absorb, copies a browser or a person already downloaded, and the build and
dependency supply chain. TLS is assumed between all parties.

**Not built, on purpose:** rate limits, quotas, per-token scopes, accounts or tenants, content scanning, a CSP on
artifact pages, OAuth for MCP, and backups of file bytes. The deployment has one owner, and the threats are the three
adversaries below, not untrusted users.

## Assets

| ID  | Asset                                                                            | Why it matters                                                                  |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A1  | Private artifacts: files, titles, descriptions and version history               | The owner's work; agents may put private data in it                             |
| A2  | API tokens                                                                       | A token reads, publishes, makes public and deletes every artifact until revoked |
| A3  | The owner's Access session (`CF_Authorization` per host) and identity            | A content JWT opens every private artifact; an app JWT opens the gallery        |
| A4  | Integrity of artifacts and their history                                         | What a URL shows is what an agent stored as that version                        |
| A5  | The owner's other services and the reputation of the domains the deployment uses | Artifact and public pages sit next to them in the shared-domain layout          |
| A6  | Cost: Workers requests and CPU, D1, R2                                           | The owner pays                                                                  |

## Adversaries

| ID  | Adversary                                                                         | Capabilities                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | An outsider on the internet, including a website the owner visits                 | Reaches every host and route with any method, header and body; makes the owner's browser load and embed URLs; holds no owner identity and no token                            |
| R2  | A buggy or prompt-injected artifact page                                          | Runs JavaScript at its artifact origin in the owner's browser, or a visitor's when public: requests, embeds, storage, service workers, cookies for its host and parent domain |
| R3  | A holder of a leaked API token, or an agent prompt-injected while holding its own | Calls every REST route and MCP tool as that token                                                                                                                             |
| R4  | A party that learns an artifact URL                                               | Requests it; for a public artifact, that URL is the share link                                                                                                                |

## Entry points

| Entry point                                     | Reached by | Authenticated by                                    |
| ----------------------------------------------- | ---------- | --------------------------------------------------- |
| Gallery on the app host                         | R1, R2     | Access; the Worker verifies the JWT (ACC-1)         |
| Private content hosts                           | R1, R2, R4 | Access; the Worker verifies the JWT (ACC-1)         |
| Public content hosts                            | R1, R2, R4 | none; the artifact's public flag (PUB-1)            |
| REST API on the API host                        | R1, R3     | bearer token (TOK-1)                                |
| MCP endpoint `/mcp` on the API host             | R1, R3     | bearer token (TOK-1) and the `Origin` rule (HOST-3) |
| Any other host or route that reaches the Worker | R1         | none; answered 404 without storage (HOST-1)         |
| CLI and the deployment script                   | the owner  | the token in the environment; the owner's account   |

## Invariants

### Hosts (HOST)

- **HOST-1: a request is classified by exact host.** The host is the app host, the API host, or a 26-character ID
  followed by exactly the content or public suffix; anything else answers 404 without reading D1 or R2. `workers_dev`
  and `preview_urls` are false. _Planned._ Pinned by behavior (hosts with an extra label, uppercase letters, prefixes of
  25 and 27 characters, a port) and source check (`wrangler.jsonc`).
- **HOST-2: a configuration that would weaken a boundary is refused.** Refused: a public suffix that ends with the
  content suffix (the content Access wildcard would cover public hosts), an app or API host under either suffix, a
  suffix that makes an artifact label longer than 63 characters, and a mix of `localhost` and other hosts. The Worker
  answers 503 `unavailable`; the deployment script refuses the same values with the same parser. _Planned._ Pinned by
  behavior (one test per refusal, for the Worker and the script).
- **HOST-3: `/mcp` refuses a foreign `Origin`.** A request that carries an `Origin` other than the API host's origin
  answers 403 before the MCP handler; agents send none. _Planned._ Pinned by behavior.

### Access (ACC)

- **ACC-1: the gallery and private content are served only with a verified Access JWT.** The Worker reads
  `Cf-Access-Jwt-Assertion` (never a cookie) and verifies it with jose: RS256 only, the team domain's issuer, the
  audience of the host's class (app or content), `exp` required, 60 s clock tolerance, a key set reused for at most 7
  days. An invalid JWT answers 403; a key set that cannot be fetched within 5 s answers 503 `unavailable`; both log a
  reason code only. _Planned._ Pinned by behavior (a local key set: missing JWT, bad signature, other issuer, the other
  class's audience, missing `exp`, expired and the tolerance edges, an algorithm other than RS256, an unknown `kid`
  that refreshes the set once, an unreachable key endpoint, a valid JWT sent only as a cookie).
- **ACC-2: Access verification is skipped only for a `localhost` configuration.** Every configured host must be a
  `localhost` name; no variable turns verification off, and the deployment script refuses `localhost` hosts and ports.
  _Planned._ Pinned by behavior (production-shaped hosts without a JWT answer 403; the script refuses `localhost`).
- **ACC-3: the Access applications admit only the owner, and their cookie is HttpOnly.** The content application covers
  exactly `*` + the content suffix. HttpOnly is set explicitly because the documented default is inconsistent; without
  it, artifact JavaScript could read its host's JWT, which names the application's audience rather than the host and so
  opens every private artifact. _Planned._ Pinned by deployed check (another identity is denied; `document.cookie` on an
  artifact host shows no `CF_Authorization`; a public host does not redirect to Access).

### API tokens (TOK)

- **TOK-1: every request to the API host needs a known bearer token.** REST routes and `/mcp` alike: the SHA-256 of the
  presented token is compared with every entry of `API_TOKENS` in constant time, before any storage is read; a failure
  answers 401 `unauthorized`. _Planned._ Pinned by behavior (each route: no header, another scheme, unknown and removed
  tokens, nothing changed) and review (the constant-time comparison).
- **TOK-2: a token is never stored, returned, logged or handed to the MCP SDK.** The secret holds hashes; D1 holds
  token names; no response echoes the `Authorization` header; the per-request MCP factory captures the token name.
  _Planned._ Pinned by log redaction and behavior (responses hold no marker token).
- **TOK-3: every version and every change records its token.** A version stores `published_by`; create, publish,
  public, archive and delete changes log the token name. _Planned._ Pinned by behavior and log redaction.

### Origin isolation (ISO)

- **ISO-1: an artifact host serves only that artifact, and an ID is never reused.** File lookups are keyed by the ID
  from the host; a deleted artifact keeps a tombstone row, and the primary key refuses an ID that existed, so no new
  artifact inherits an old origin's storage or service worker. _Planned._ Pinned by behavior (two artifacts with the
  same path and different bytes each serve their own; create with a generator stubbed to a deleted ID is refused).
- **ISO-2: private content cannot be read or embedded from another origin.** No host sends `Access-Control-Allow-*`,
  and `OPTIONS` answers 405, so a cross-origin `fetch` cannot read a response. Every response of a private content host
  and of the app host carries `Cross-Origin-Resource-Policy: same-origin` (200, 304, 308, 404), so another origin's
  `<script>`, `<img>`, `<link>` or media element cannot load it with the owner's cookie and observe it. Public hosts
  do not send it: their content needs no credential, so embedding it reveals nothing a direct request does not.
  _Planned._ Pinned by behavior (every route and status, both host classes) and deployed check (design AC-8: artifact
  A's `<script src>` to artifact B fails, B loads its own).
- **ISO-3: browsers can only read.** The app host and content hosts answer `GET` and `HEAD` only; every change is on the
  API host with a bearer token, so no request authenticated by a cookie changes state. _Planned._ Pinned by behavior.
- **ISO-4: the Worker sets no cookie and decides nothing on one.** _Planned._ Pinned by behavior (no `Set-Cookie` on
  any route; a valid Access JWT sent only as a cookie is refused, ACC-1).
- **ISO-5: the gallery runs no artifact-supplied markup.** Titles, descriptions and paths are escaped; the response's
  `Content-Security-Policy` forbids scripts and framing. _Planned._ Pinned by behavior (markup and attribute breakouts
  in each field; the header).

### Serving (SRV)

- **SRV-1: content responses do not reinterpret bytes or leak the host.** Each carries the stored `Content-Type`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. _Planned._ Pinned by behavior.
- **SRV-2: a request path selects a file of the requested artifact and version only.** The Worker resolves the pathname
  it receives: one strict percent-decoding per segment, an encoded `/` refused, lookup inside the selected version's
  file list. _Planned._ Pinned by behavior (decoder tests over strings; Worker tests over `Request` objects asserting
  the selected version and file).
- **SRV-3: a 304 never skips a check.** Access (ACC-1), the public flag (PUB-1) and the artifact's existence are checked
  before `If-None-Match` is compared, for latest and pinned versions alike, and every content response revalidates
  (`no-cache`). _Planned._ Pinned by behavior (a matching `If-None-Match` after the artifact was made private or
  deleted answers 404; without a valid JWT, 403).

### Public links (PUB)

- **PUB-1: a public host serves an artifact only while it is public, and then every version.** The flag is read on
  every request; a private, deleted or unknown artifact answers the same 404. Making an artifact public exposes its
  latest and all pinned versions. A public host never serves the gallery or the API. _Planned._ Pinned by behavior
  (the three 404s are identical; pinned versions are served while public; the next request after making it private
  answers 404).
- **PUB-2: only the API changes the flag**, with a token (TOK-1); the flag is off when an artifact is created.
  _Planned._ Pinned by behavior.

### Versions (VER)

- **VER-1: a stored version never changes.** No operation rewrites a version's rows; an object's key is the SHA-256
  the Worker computed from its bytes. _Planned._ Pinned by behavior (after publishes that share and change files,
  earlier versions' rows and bytes are unchanged and every key matches its bytes).
- **VER-2: a publish becomes visible only through its single commit.** Bytes are uploaded first; the version appears
  in one D1 batch, which rolls back as a whole. A failure before the commit, or a commit that rolls back, leaves no
  version. The commit has no timeout of its own, since a timed-out commit could still apply; when a disconnect cancels
  the request, the outcome is learned by reading, as [design.md](design.md#publish) describes. _Planned._ Pinned by
  behavior (a failure at each upload, an upload timeout, a failing batch).
- **VER-3: an update commits only on top of the latest version.** A `base_version` that is not the latest, or an
  artifact deleted meanwhile, commits nothing. _Planned._ Pinned by behavior (stale base; two concurrent updates from
  one base commit exactly one; a delete between upload and commit).
- **VER-4: objects belong to one artifact, and deletion is logical first.** Keys are `a/<id>/<sha256>`; no version
  references another artifact's object. Deleting commits the tombstone and removes the rows at once, so every URL
  answers 404; removing the prefix's objects follows, best effort, and a repeated delete retries it. _Planned._ Pinned
  by behavior (URLs 404 right after delete; the prefix is empty after a cleanup that succeeded; a failed cleanup
  completes on the repeated delete).

### Resources (RES)

- **RES-1: input is bounded before it is used.** The bounds of [design.md](design.md#limits), each in its unit;
  request bodies are counted while they are read. _Planned._ Pinned by behavior (at and one past each bound; a chunked
  body without `Content-Length`).
- **RES-2: waits are bounded where the outcome stays known.** Fetching Access keys, each R2 call and each D1 read have a
  timeout and answer 503 `unavailable`; a publish that times out before its commit leaves no version. The D1 commit
  has none: a timed-out commit could still apply. _Planned._ Pinned by behavior (slow key endpoint, R2 and D1 reads).

### Data (DATA)

- **DATA-1: logs carry no secret and no artifact content.** Only `logEvent` writes to the console, with fields from
  closed sets (event names, reason codes, error classes, token names, artifact IDs, version numbers, counts): never a
  token, an `Authorization` header, an Access JWT or cookie, file bytes, a title, a description or a path. Invocation
  logs are off. _Planned._ Pinned by log redaction (every route and failure path) and source check (`console` only in
  the logging module; `wrangler.jsonc`).
- **DATA-2: deployment values stay out of the repository.** `wrangler.jsonc` sets no variable, route or identifier;
  the deployment file is gitignored, and `API_TOKENS` is a secret. _Planned._ Pinned by source check of
  `wrangler.jsonc` and the deployment example.

## IDs to check by change type

- **Routing or configuration:** HOST-1 to HOST-3, ACC-2, ISO-2, ISO-3, DATA-2.
- **Access or tokens:** ACC-1 to ACC-3, TOK-1 to TOK-3.
- **Serving:** ISO-1, ISO-2, SRV-1 to SRV-3, PUB-1, RES-2.
- **Publish, update, archive or delete:** VER-1 to VER-4, RES-1, RES-2, TOK-3.
- **Gallery:** ISO-2 to ISO-5.
- **Logging:** DATA-1; extend the redaction markers to the new path.

## Accepted risks

| Risk                                                                                                                                                                                                                                                                                                                                     | Why accepted                                                                                                                                                  | Holds while, or revisit when                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A leaked token (R3) reads, publishes, makes public and deletes every artifact until revoked; deleted bytes cannot be recovered                                                                                                                                                                                                           | One owner; one token per agent, revoked by editing a secret; versions and logs name the token; artifacts are agent output that can be produced again          | Revisit when an artifact is the only copy of something, or a token goes to an agent the owner does not run                                                                                                   |
| No per-token scopes: an agent prompt-injected while holding its own token can delete or make public                                                                                                                                                                                                                                      | Scopes would need a policy model for one person. Whether a client asks before a tool call is the owner's client configuration, not a control here             | Revisit when an agent runs unattended with these tools                                                                                                                                                       |
| An artifact page (R2) can send requests, not read or embed answers, to other artifact hosts, the gallery and the API, with the owner's cookies where the browser sends them                                                                                                                                                              | Every such target only reads (ISO-3), and nothing can be read or embedded across origins (ISO-2)                                                              | Holds while ISO-2 and ISO-3 hold                                                                                                                                                                             |
| An artifact page can read the owner's Access identity (email, name) if Access answers its identity endpoint on artifact hosts; the documentation describes it on the team domain only                                                                                                                                                    | It is identity, not a credential (the JWT stays HttpOnly, ACC-3)                                                                                              | Revisit when the identity carries sensitive claims                                                                                                                                                           |
| A page's own browser state (storage, service worker) spans all its versions and can change what an old version shows in the owner's browser                                                                                                                                                                                              | Versions share the origin by design; stored bytes are immutable (VER-1); clearing site data resets the state                                                  | Revisit when versions must be inspected independently of the page's own code                                                                                                                                 |
| Shared-domain layout: an artifact page can set cookies for the owner's domain, which the owner's other services then receive, and its requests to them are same-site; it can break Access sign-in on the app host until cookies are cleared; a page published with a leaked token sits on the owner's domain (reputation, Safe Browsing) | A supported layout the owner chooses; this deployment's own protections rely on neither cookies set by siblings nor `SameSite` (ACC-1, TOK-1, ISO-2 to ISO-4) | Holds while the owner's other services on that domain do not trust cookies a sibling host can set and do not rely on `SameSite` alone against cross-site requests; otherwise use the dedicated-domain layout |
| Making an artifact public exposes every version, including ones published before                                                                                                                                                                                                                                                         | One flag per artifact keeps sharing simple; the owner decides per artifact                                                                                    | Revisit when single versions must be shared                                                                                                                                                                  |
| A public artifact's host, its share link, reaches parties its page contacts (the `Origin` of CORS requests, anything the page sends)                                                                                                                                                                                                     | Public means published; the 130-bit ID protects against guessing, not against the page disclosing itself                                                      | Revisit when share links must be revocable or expire independently of the flag                                                                                                                               |
| Objects that no version references remain after a failed or raced publish, and until a failed cleanup is retried                                                                                                                                                                                                                         | They are never served (VER-2) and cost storage only                                                                                                           | Revisit when their storage becomes noticeable                                                                                                                                                                |
| Outsiders (R1) can make the Worker answer 401, 403 and 404 at the owner's expense                                                                                                                                                                                                                                                        | Each refusal comes before any storage call (HOST-1, ACC-1, TOK-1); Cloudflare absorbs volumetric attacks                                                      | Revisit when unauthenticated traffic costs noticeably (A6)                                                                                                                                                   |

## How to use

- **Changes** list the invariant IDs they touch and the status changes they make to this file.
- **Tests** name the invariant in the test name or a comment (for example `// ISO-2`), so a search for the ID shows its
  coverage.
