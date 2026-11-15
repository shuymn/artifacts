# Threat model

What `artifacts` protects, from whom, and the security invariants the code must keep, by ID (for example `ISO-2`). It
covers security only; correctness and design are in [design.md](design.md), libraries and patterns in
[decisions.md](decisions.md).

**Keep it current.** A change that adds an entry point, asset, trust boundary or accepted risk, or changes an
invariant's status, updates this file. IDs are never reused: an invariant that no longer applies is marked retired
with the reason.

## Status of an invariant

**Enforced (main):** the cited source and test exist on `main`. **Planned (first release):** not implemented; required
before the first release ships. Every invariant below is _Planned (first release)_.

A **Gap** note names a part that no test pins yet; that part does not count as enforced.

## How an invariant is pinned

Each invariant names how its test pins it.

- **Behavior:** a test drives the Worker, in the local runtime with D1 and R2, or a unit, and checks the result (a
  status, headers, rows, objects).
- **Source analysis:** a test reads the sources and fails on a forbidden shape (an import, an API, a call). It also
  feeds its patterns small fixtures that must be detected, so a pattern that silently stopped matching fails.
- **Log redaction:** a behavior test that sends marker values (tokens, JWTs, file bytes, titles, paths) through a path,
  captures every `console` method, and asserts that no marker appears.
- **Configuration:** a setting in a configuration file that a test reads.
- **Deployed check:** a setting outside the repository (an Access application, DNS) checked on the deployed Worker with
  a browser or a client, as listed in the purpose layer of [design.md](design.md#purpose-layer-acceptance-criteria).

## Deployment assumptions

- One owner deploys and uses a deployment; nobody else has an account on it. Agents act for the owner with their own
  tokens.
- One Worker serves the app host (the gallery), the API host (REST and MCP), a host per artifact for private content,
  and optionally a host per public artifact. Hosts, the account, the database and the bucket are deployment values in a
  gitignored file.
- Access protects the app host and the private content hosts with two self-hosted applications whose policies admit
  only the owner. The API host and the public content hosts are not behind Access.
- D1 holds metadata; a private R2 bucket holds file bytes.
- The owner's machine runs the agents and the CLI; a token lives in an agent's or the CLI's configuration there.

**Out of scope:** a compromised Cloudflare account or platform, a compromised Access identity provider, a compromised
owner machine beyond the leak of a token (R3), the owner acting against their own deployment, denial of service at a
scale Cloudflare's own protection does not absorb, and the build and dependency supply chain, which this model does
not cover. TLS is assumed between all parties.

**Not built, on purpose (P1):** rate limits, quotas, per-token scopes, accounts or tenants, content scanning, a CSP on
artifact pages, OAuth for MCP, and backups of file bytes.

## Assets

| ID  | Asset                                                                            | Why it matters                                                                  |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A1  | Private artifacts: files, titles, descriptions and version history               | The owner's work; agents may put private data in it                             |
| A2  | API tokens                                                                       | A token reads, publishes, makes public and deletes every artifact until revoked |
| A3  | The owner's Access session (`CF_Authorization` per host) and identity            | A content JWT opens every private artifact; an app JWT opens the gallery        |
| A4  | Integrity of artifacts and their history                                         | What a URL shows is what an agent published as that version                     |
| A5  | The owner's other services and the reputation of the domains the deployment uses | Artifact pages and public pages sit next to them in the shared-domain layout    |
| A6  | Cost: Workers requests and CPU, D1, R2                                           | The owner pays                                                                  |

## Adversaries

| ID  | Adversary                                                                         | Capabilities                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | An outsider on the internet                                                       | Reaches every host and route with any method, header and body; holds no owner identity and no token                                                                                       |
| R2  | A buggy or prompt-injected artifact page                                          | Runs JavaScript at its artifact origin in the owner's browser, or a visitor's when public: requests, storage, service workers, cookies for its host and parent domain, navigation, frames |
| R3  | A holder of a leaked API token, or an agent prompt-injected while holding its own | Calls every REST route and MCP tool as that token                                                                                                                                         |
| R4  | A party that learns an artifact URL                                               | Requests it; for a public artifact, that URL is the share link                                                                                                                            |

## Entry points

| Entry point                                 | Reached by | Authenticated by                                  | Status                  |
| ------------------------------------------- | ---------- | ------------------------------------------------- | ----------------------- |
| Gallery on the app host                     | R1, R2     | Access; the Worker verifies the JWT (ACC-1)       | Planned (first release) |
| Private content hosts                       | R1, R2, R4 | Access; the Worker verifies the JWT (ACC-1)       | Planned (first release) |
| Public content hosts                        | R1, R2, R4 | none; the artifact's public flag (PUB-1)          | Planned (first release) |
| REST API on the API host                    | R1, R3     | bearer token (TOK-1)                              | Planned (first release) |
| MCP endpoint `/mcp` on the API host         | R1, R3     | bearer token (TOK-1)                              | Planned (first release) |
| Any other host or route reaching the Worker | R1         | none; answered 404 without storage (HOST-1)       | Planned (first release) |
| CLI and the deployment script               | the owner  | the token in the environment; the owner's account | Planned (first release) |

## Invariants

### Hosts (HOST)

- **HOST-1: a request is classified by exact host.** The host is the app host, the API host, or a 26-character ID
  followed by exactly the content or public suffix; anything else answers 404 without reading D1 or R2. The URL is
  compared as the runtime parsed it. `workers_dev` and `preview_urls` are false, so the Worker has no other hostname.
  _Planned (first release)._ Pinned by behavior (routing over hosts with an extra label, uppercase letters, prefixes of
  25 and 27 characters, a port) and by configuration (`wrangler.jsonc`).
- **HOST-2: a configuration that would weaken a boundary is refused.** Refused: a public suffix that ends with the
  content suffix (the content Access wildcard would cover public hosts), an app or API host under either suffix, a
  suffix whose label part would make an artifact label longer than 63 characters, and a mix of `localhost` and other
  hosts. The Worker answers 503 with an invalid configuration; the deployment script refuses it with the same parser.
  _Planned (first release)._ Pinned by behavior (configuration and deployment-script tests, one per refusal).

### Access (ACC)

- **ACC-1: the gallery and private content are served only with a verified Access JWT.** The Worker reads
  `Cf-Access-Jwt-Assertion` (never a cookie) and verifies it with jose: RS256 only, the team domain's issuer, the
  audience of the host's class (app or content), `exp` required, 60 s clock tolerance, a key set reused for at most 7
  days, and a 5 s timeout on fetching keys. A failure answers 403 with no detail and logs a reason code only.
  _Planned (first release)._ Pinned by behavior (a local key set: missing, bad signature, other issuer, the other
  class's audience, expired, valid JWT only in a cookie) and source analysis (no cookie read in the Access path).
- **ACC-2: Access verification is skipped only for a `localhost` configuration.** Every configured host must be a
  `localhost` name for the skip to apply; no variable turns verification off. The deployment script refuses
  `localhost` hosts and ports. _Planned (first release)._ Pinned by behavior (production-shaped hosts without a JWT
  answer 403; the deployment script refuses a `localhost` host).
- **ACC-3: the Access applications admit only the owner, and their cookie is HttpOnly.** The content application covers
  exactly `*` + the content suffix. HttpOnly is set explicitly, because the documented default is inconsistent; without
  it, artifact JavaScript could read its host's JWT, which names the application's audience rather than the host, and
  so opens every private artifact. _Planned (first release)._ Pinned by deployed check (sign-in with another identity
  is denied; `document.cookie` on an artifact host shows no `CF_Authorization`; a public host does not redirect to
  Access).

### API tokens (TOK)

- **TOK-1: every request to the API host needs a known bearer token.** REST routes and `/mcp` alike: the SHA-256 of the
  presented token is compared with every entry of `API_TOKENS` with `crypto.subtle.timingSafeEqual`, before any
  storage is read. A failure answers 401 `unauthorized`. _Planned (first release)._ Pinned by behavior (each route:
  no header, another scheme, unknown and removed tokens) and source analysis (the comparison).
- **TOK-2: a token is never stored, returned or logged.** The secret holds hashes; D1 holds token names only; no
  response echoes the `Authorization` header; the MCP handler receives the token name, not the token. _Planned (first
  release)._ Pinned by log redaction and behavior (responses hold no marker token).
- **TOK-3: every version and every change records its token.** A version stores `published_by`; creating, publishing,
  changing visibility and deleting each log the token name. _Planned (first release)._ Pinned by behavior and log
  redaction (the logged fields are the closed set of DATA-1).

### Origin isolation (ISO)

- **ISO-1: an artifact host serves only that artifact, and an ID is never reused.** File lookups are keyed by the ID
  from the host; a deleted artifact keeps its row, and the primary key refuses an ID that existed, so no new artifact
  inherits an old origin's storage or service worker. _Planned (first release)._ Pinned by behavior (another artifact's
  path answers 404; create with a stubbed generator returning a deleted ID is refused).
- **ISO-2: no response allows a cross-origin read.** No host sends `Access-Control-Allow-*`; `OPTIONS` answers 405.
  _Planned (first release)._ Pinned by behavior (every route and error answer) and source analysis.
- **ISO-3: browsers can only read.** The app host and content hosts answer `GET` and `HEAD` only; every change is on the
  API host with a bearer token, so no request authenticated by a cookie changes state. _Planned (first release)._
  Pinned by behavior (each method on each host class).
- **ISO-4: the Worker sets no cookie and decides nothing on one.** _Planned (first release)._ Pinned by behavior (no
  `Set-Cookie` on any route) and source analysis (no cookie header read).
- **ISO-5: the gallery runs no artifact-supplied markup.** Titles, descriptions and paths are escaped by one function;
  the response's `Content-Security-Policy` forbids scripts and framing. _Planned (first release)._ Pinned by behavior
  (markup and attribute breakouts in titles and descriptions) and source analysis (pages built only through the
  escaping template).

### Serving (SRV)

- **SRV-1: content responses do not reinterpret bytes or leak the host.** Each carries the stored `Content-Type`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. _Planned (first release)._ Pinned by behavior.
- **SRV-2: a request path resolves only to a file of the requested version.** Each segment is percent-decoded strictly;
  a malformed escape, invalid UTF-8, an encoded `/`, a dot segment or a forbidden character answers 404; the result is
  normalized to NFC and looked up in that version's file list. _Planned (first release)._ Pinned by behavior (`%2e%2e`,
  `%2F`, `%C0%AF`, a lone `%`, NFD input).

### Public links (PUB)

- **PUB-1: a public host serves an artifact only while it is public.** The flag is read on every request; a private,
  deleted or unknown artifact answers the same 404. A public host never serves the gallery or the API. _Planned (first
  release)._ Pinned by behavior (the three 404 responses are identical; making an artifact private takes effect on the
  next request).
- **PUB-2: only the API changes the flag.** It requires a token (TOK-1) and fails with `public_disabled` when no public
  suffix is configured. _Planned (first release)._ Pinned by behavior.

### Versions (VER)

- **VER-1: a committed version never changes.** No statement updates or deletes a `versions` or `version_files` row
  except deleting the whole artifact; a file's object key is the SHA-256 the Worker computed from the bytes it stored.
  _Planned (first release)._ Pinned by source analysis (the SQL that touches those tables) and behavior (keys after
  publishes).
- **VER-2: a publish becomes visible only through its single commit.** Bytes are uploaded first; the version appears in
  one D1 batch, which rolls back as a whole. A failure before or in the commit leaves no version. _Planned (first
  release)._ Pinned by behavior (a failure injected at each upload, a timeout, a failing batch).
- **VER-3: an update commits only on top of the latest version.** A `base_version` that is not the latest, or an
  artifact deleted meanwhile, commits nothing and answers `version_conflict` or `not_found`. _Planned (first release)._
  Pinned by behavior (stale base; two concurrent updates from one base commit exactly one; delete between upload and
  commit).
- **VER-4: objects belong to one artifact.** Keys are `a/<id>/<sha256>`; no version references another artifact's
  object; deleting an artifact removes its rows, then its prefix. _Planned (first release)._ Pinned by behavior (R2 and
  D1 contents after publishes and a delete).

### Resources (RES)

- **RES-1: input is bounded before it is used.** The bounds of [design.md](design.md#limits), each in its unit; request
  bodies are counted while they are read. They catch agent mistakes and keep requests within the platform's limits.
  _Planned (first release)._ Pinned by behavior (at and one past each bound, with astral and multibyte characters; a
  chunked body without `Content-Length`).
- **RES-2: every wait on another service is bounded.** Fetching Access keys, each R2 call and each D1 call have a
  timeout; a timeout answers 503 `unavailable` and leaves no version (VER-2). _Planned (first release)._ Pinned by
  behavior (stubbed slow key endpoint and storage).

### Data (DATA)

- **DATA-1: logs carry no secret and no artifact content.** Only `logEvent` writes to the console, with fields from
  closed sets (event names, reason codes, error classes, token names, artifact IDs, version numbers, counts). Never a
  token, an `Authorization` header, an Access JWT or cookie, file bytes, a title, a description or a path. Invocation
  logs are off, because they record the request. _Planned (first release)._ Pinned by log redaction (every route and
  failure path), source analysis (`console` only in the logging module) and configuration (`wrangler.jsonc`).
- **DATA-2: deployment values stay out of the repository.** `wrangler.jsonc` sets no variable, route or identifier;
  the deployment file is gitignored, and `API_TOKENS` is a secret. _Planned (first release)._ Pinned by configuration
  (a test reads `wrangler.jsonc` and the deployment example).

## IDs to check by change type

- **Routing or configuration:** HOST-1, HOST-2, ACC-2, ISO-2, ISO-3, DATA-2.
- **Access or tokens:** ACC-1 to ACC-3, TOK-1 to TOK-3.
- **Serving:** ISO-1, SRV-1, SRV-2, PUB-1, RES-2.
- **Publish, update or delete:** VER-1 to VER-4, RES-1, RES-2, TOK-3.
- **Gallery:** ISO-3 to ISO-5.
- **MCP or REST adapters:** TOK-1, TOK-2, RES-1, and the shared-operation test (design PL-33).
- **Logging:** DATA-1. Extend the redaction markers to the new path.

## Accepted risks

| Risk                                                                                                                                                                                                                                                                            | Why accepted                                                                                                                                         | Holds while, or revisit when                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A leaked token (R3) reads, publishes, makes public and deletes every artifact until revoked; deleted bytes cannot be recovered                                                                                                                                                  | One owner; one token per agent, revoked by editing a secret; versions and logs name the token; artifacts are agent output that can be produced again | Revisit when an artifact is the only copy of something, or a token goes to an agent the owner does not run                                                                         |
| No per-token scopes: an agent prompt-injected while holding its own token can delete or make public                                                                                                                                                                             | Clients confirm tool calls that are not allowlisted, and `delete_artifact` is marked destructive; scopes would need a policy model for one person    | Revisit when an agent runs unattended with these tools allowlisted                                                                                                                 |
| An artifact page (R2) can send requests, not read answers, to other artifact hosts, the gallery and the API, with the owner's cookies where the browser sends them                                                                                                              | Every such target only reads (ISO-3), and no answer allows a cross-origin read (ISO-2)                                                               | Holds while ISO-2 and ISO-3 hold                                                                                                                                                   |
| An artifact page can read the owner's Access identity (email, name) if Access answers its identity endpoint on artifact hosts; the documentation describes the endpoint on the team domain only                                                                                 | It is identity, not a credential (the JWT stays HttpOnly, ACC-3)                                                                                     | Revisit when the identity carries sensitive claims                                                                                                                                 |
| An artifact's service worker controls the URLs of all its versions in the owner's browser                                                                                                                                                                                       | Versions share the origin by design; stored bytes are immutable; clearing site data resets it                                                        | Revisit when versions must be inspected independently of the page's own code                                                                                                       |
| Shared-domain layout: an artifact page can toss cookies to, and send same-site requests to, the owner's other services on that domain, and break Access sign-in on the app host until cookies are cleared; a page published with a leaked token sits on the owner's main domain | The owner's choice of layout; this deployment's own protections rely on neither cookies nor `SameSite` (ACC-1, TOK-1, ISO-2 to ISO-4)                | Holds while the owner's other services on that domain do not trust cookies set by a sibling host or rely on `SameSite` alone; otherwise move content to its own registrable domain |
| A public artifact's host, its share link, reaches parties its page contacts (the `Origin` of CORS requests, anything the page sends)                                                                                                                                            | Public means published; the ID protects against guessing (130 bits), not against the page disclosing itself                                          | Revisit when share links must be revocable or expire independently of the public flag                                                                                              |
| Objects that no version references remain after a failed or raced publish or an interrupted delete                                                                                                                                                                              | They are never served (VER-2) and cost storage only                                                                                                  | Revisit when their storage becomes noticeable                                                                                                                                      |
| Outsiders (R1) can make the Worker answer 401, 403 and 404 at the owner's expense                                                                                                                                                                                               | Each refusal is answered before any storage call (HOST-1, ACC-1, TOK-1); Cloudflare absorbs volumetric attacks                                       | Revisit when unauthenticated traffic costs noticeably (A6)                                                                                                                         |

## How to use

- **Changes** list the invariant IDs they touch and the status changes they make to this file.
- **Tests** name the invariant in the test name or a comment (for example `// ISO-2`), so a search for the ID shows its
  coverage.
- This document covers security only.
