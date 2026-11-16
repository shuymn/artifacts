# Design

What `artifacts` is for, the principles every decision is measured against, the decisions, and the acceptance criteria
that say when the first release is done. Security invariants (IDs such as `ISO-2`) are in
[threat-model.md](threat-model.md); libraries and code patterns are in [decisions.md](decisions.md).

## Purpose

AI agents (Claude, Codex, Gemini CLI, scripts) publish HTML pages with their CSS, JavaScript and images to a host the
owner runs on Cloudflare. The owner opens each page in a browser at its own origin. Every update is a new version, and
earlier versions stay viewable. A gallery lists everything, with old artifacts archived out of its default list. An
artifact can be shared through a public link.

One person deploys and uses a deployment. It is not a multi-tenant or open service.

## Principles

| ID  | Principle                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **One owner.** Every legitimate caller is the owner or an agent the owner gave a credential: an API token, or an OAuth grant the owner approved. Defenses target a page an agent wrote that is buggy or prompt-injected, a leaked credential, and outsiders reaching the hosts. Nothing is built against untrusted users (quotas, rate limits, tenants). A safe default is taken when it is cheap; it is never a requirement. |
| P2  | **Each artifact is its own origin.** Artifact JavaScript reads its own files and storage and nothing else this host serves.                                                                                                                                                                                                                                                                                                   |
| P3  | **Browsers only read artifacts.** Every change to an artifact goes through the API with a bearer credential; no request authenticated by a cookie changes one. The one write a browser makes is the owner approving an OAuth grant on the consent page that the same browser opened (section 7).                                                                                                                              |
| P4  | **A stored version never changes, and a publish is all or nothing.**                                                                                                                                                                                                                                                                                                                                                          |
| P5  | **One operation layer.** REST, MCP and the CLI are adapters over the same operations and operation error codes.                                                                                                                                                                                                                                                                                                               |
| P6  | **The platform before own code, and the simpler option** when the risk the other guards against needs an untrusted user.                                                                                                                                                                                                                                                                                                      |
| P7  | **Deployment values stay out of the repository.**                                                                                                                                                                                                                                                                                                                                                                             |

A restriction stays only with a reason tied to the purpose or to an implementation bound. A side effect a decision
accepts is stated where the decision is, with what is not lost.

## Overview

One Worker serves every host on Workers Paid. D1 holds metadata, R2 holds file bytes, KV holds OAuth clients, grants and
tokens.

| Host                           | Example                     | Serves                                                           | Authenticated by                                                       |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `APP_HOST`                     | `artifacts.example.com`     | the gallery, read-only; the OAuth consent page                   | Access; the Worker verifies the JWT                                    |
| `API_HOST`                     | `artifacts-api.example.com` | REST under `/v1/`, MCP at `/mcp`, the OAuth authorization server | a bearer OAuth access token or API token; the OAuth endpoints are open |
| `<id>` + `CONTENT_HOST_SUFFIX` | `<id>-art.example.com`      | one artifact's files                                             | Access; the Worker verifies the JWT                                    |
| `<id>` + `PUBLIC_HOST_SUFFIX`  | `<id>-pub.example.com`      | one artifact's files, if it is public                            | none                                                                   |

## 1. Hosts and origins

Hosts are deployment values. An artifact's host is its ID followed by a suffix; IDs have a fixed length of 26
characters, so the Worker classifies a host by exact comparison: `APP_HOST`, `API_HOST`, or a valid ID followed by
exactly one of the suffixes. Anything else answers 404 without touching storage (HOST-1). A suffix is `-label.domain`
or `.domain`; either keeps the artifact host a first-level subdomain. The configuration check refuses values that would
weaken a boundary (HOST-2).

### Layouts

Both layouts are supported deployments; they differ in what shares a registrable domain with artifact pages.

| Setting                | One domain the owner already uses             | Content on its own registrable domain               |
| ---------------------- | --------------------------------------------- | --------------------------------------------------- |
| `APP_HOST`, `API_HOST` | Workers Custom Domains on `example.com`       | Workers Custom Domains on `example.com`             |
| `CONTENT_HOST_SUFFIX`  | `-art.example.com`                            | `-p.example-content.net`                            |
| `PUBLIC_HOST_SUFFIX`   | `-pub.example.com`                            | `-s.example-content.net`                            |
| Workers Routes         | `*-art.example.com/*`, `*-pub.example.com/*`  | `*.example-content.net/*`                           |
| DNS                    | proxied wildcard record `*.example.com`       | proxied wildcard record `*.example-content.net`     |
| Access applications    | app: `APP_HOST`; content: `*-art.example.com` | app: `APP_HOST`; content: `*-p.example-content.net` |
| Same site as pages     | the owner's other services on `example.com`   | other artifacts only                                |

- **Certificates:** Universal SSL covers first-level subdomains only
  ([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)), so the
  artifact's label carries the suffix instead of a deeper name.
- **Routes:** Custom Domains take no wildcards
  ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)); a Route takes a
  leading wildcard with a partial label and needs a proxied DNS record
  ([Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)). A label suffix matches only
  names that end in it, so on a shared domain it captures none of the owner's other hosts as long as none uses that
  ending; no negation routes are needed.
- **DNS on a shared domain:** DNS wildcards cover whole labels, so the zone gets a proxied `*` record. Every name with
  its own record resolves as before; only names without one reach Cloudflare and get an error instead of NXDOMAIN.
- **Access:** a self-hosted application takes a partial-label wildcard and one AUD tag
  ([application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)); two
  applications keep the app and content audiences apart and work across zones. The API host and the public hosts stay
  outside Access: agents and the OAuth endpoints carry no Access session, and a share link needs none. Where an
  application already covers the whole zone, each of them gets a Bypass application of its own
  ([operations.md](operations.md#access)). The host classifier stays the authority on what each host serves: on a
  content or public host an OAuth-shaped path is an artifact path, and the OAuth library is never invoked there
  (HOST-1).

### Cookies and what artifact JavaScript can reach

Artifact JavaScript can set a cookie for its host's parent domain, which every host under it then receives, and its
requests to hosts of the same registrable domain are same-site. In the shared-domain layout that reaches the owner's
other services; the threat model's accepted risk states the conditions under which this holds. This deployment's own
protections hold in both layouts: the gallery and the API read no cookie (ACC-1, TOK-1); the one cookie the Worker
reads, the consent page's `__Host-` binding, cannot be set by another host (ISO-4); no artifact changes on a cookie
(ISO-3); and nothing private can be read or loaded as a subresource across origins (ISO-2).

| Target                                   | Can                                                    | Cannot                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its own files, all versions              | read                                                   | change them                                                                                                                                                                |
| Its own storage, cookies, service worker | everything; all versions share them                    | reach another artifact's                                                                                                                                                   |
| Other artifact hosts, the gallery        | send requests (the owner's Access cookie may go along) | read a response or load it as a subresource (ISO-2); change state                                                                                                          |
| The API and the OAuth endpoints          | send requests without a credential                     | authenticate; read an answer (ISO-2)                                                                                                                                       |
| The consent page on the app host         | open it at the top level, as any site can              | approve: consent is never remembered, and approving needs the handle the page holds and the page's cookie; frame it; receive a code at an artifact host (OAUTH-1, OAUTH-2) |
| Its host's `CF_Authorization` cookie     | —                                                      | read it (ACC-3)                                                                                                                                                            |

### Local development

Hosts such as `app.localhost:8787` and the suffix `-art.localhost:8787` come from `.dev.vars`. Access verification is
skipped only when every configured host is a `localhost` name, and the deployment script refuses `localhost` hosts
(ACC-2); no switch exists that could be copied into a deployment. OAuth is off there: the library takes plain `http`
only on loopback hosts, not on names under `localhost`, so the API takes API tokens only (section 7).

## 2. Artifact identity

- **ID:** 26 characters from `a-z2-7` (RFC 4648 base32, lowercase), each from 5 bits of a byte of
  `crypto.getRandomValues`: 130 bits, a valid DNS label, and not guessable from a public link. Deleting keeps a
  tombstone row, so an ID is never reused and no new artifact inherits an old origin's state (ISO-1).
- **Title:** non-empty, one line (no control characters), at most 1 KiB of UTF-8: lists show it on one line.
- **Description:** any text, tabs and line breaks included, at most 16 KiB of UTF-8: a listing carries it for up to 100
  artifacts.
- Both belong to a version; the artifact shows its latest version's. An update that omits them keeps the base's.

## 3. Data model and storage

| Table           | Columns                                                                                                    | Keys                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `artifacts`     | `id`, `created_at`, `updated_at`, `latest_version`, `public`, `archive`, `deleted_at`                      | primary `id`                                               |
| `versions`      | `artifact_id`, `number`, `created_at`, `published_by`, `title`, `description`, `file_count`, `total_bytes` | primary (`artifact_id`, `number`); foreign `artifact_id`   |
| `version_files` | `artifact_id`, `number`, `path`, `sha256`, `size`, `content_type`                                          | primary (`artifact_id`, `number`, `path`); foreign version |

`published_by` is the publisher name of the credential that published the version (section 7): an API token's name, or
the name the owner gave a grant on the consent page. Both have the form `[a-z0-9-]{1,32}`, so the column is unchanged.
A name need not be unique: two machines may publish as `claude-code`, and the change logs carry the grant's ID beside
it (TOK-3).

`updated_at` is the time of the latest version, set as `MAX(now, updated_at)` so it never decreases. A file's bytes
are the R2 object `a/<id>/<sha256 hex>`: equal bytes are stored once per artifact, and no object is shared between
artifacts, so deleting an artifact deletes its prefix without reference checks (VER-4).

D1 rather than a SQLite Durable Object: `batch()` is one transaction that a failing statement rolls back
([D1 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)), foreign keys are enforced by default
([foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)), and the keys detect what the object's
serialization would prevent. Nothing here needs a long-lived object.

### Publish

1. Authenticate, then validate the whole input, including the merged file list and `index.html`, before any write.
2. On an update, read the base version's file list.
3. Hash each provided file (SHA-256) and deduplicate by hash. For each hash the base does not reference, `head` its
   key; a missing object is `put`, at most six at a time. An existing object is already correct, being
   content-addressed. R2 accepts one write per second per key and answers others with 429
   ([R2 limits](https://developers.cloudflare.com/r2/platform/limits/)), so a rate-limited `put` is retried twice after
   a second and then fails the publish. Each R2 call has a timeout (RES-2). No locks.
4. Commit in one D1 batch: the artifact row (inserted on create; on update, advanced from `base_version` while the
   artifact is live), the version row and every `version_files` row, provided and kept, each statement after the first
   conditioned on the advanced row and backed by the keys. A conflict leaves no advanced row or violates a key, and the
   batch rolls back. The commit has no timeout of its own, because a commit that timed out could still apply; D1 bounds
   a batch at 30 s ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
5. Answer with the artifact and the new version.

| Event                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Validation fails                                        | nothing written                                                                                                                                                                                                                                                                                                                                                                            |
| An upload fails or times out; the batch rolls back      | no version; uploaded objects stay under the prefix, referenced by nothing. Nothing deletes them: a concurrent publish may have committed the same hash                                                                                                                                                                                                                                     |
| Two updates from the same base                          | one version; the other answers `version_conflict` with `latest_version`                                                                                                                                                                                                                                                                                                                    |
| A delete while an update is in flight                   | the update's commit finds no live artifact and answers `not_found`                                                                                                                                                                                                                                                                                                                         |
| The agent loses the response (disconnect, cancellation) | the commit may or may not have applied. A lost **update** is reconciled by `base_version`: a retry answers `version_conflict` if the first applied, and `get_artifact` shows whose version is latest. A lost **create** retried blindly makes a second artifact; the MCP instructions and the CLI tell the agent to list first. A duplicate loses nothing and is deleted like any artifact |

Unreferenced objects are never served, since serving reads `version_files`; they cost storage until the artifact is
deleted.

## 4. Versions

- Every publish creates version `n + 1`; creating creates version 1. The **version history** is the history of stored
  bytes and metadata, which never change (VER-1).
- **Update input:** `base_version` (required), `files` (each replaces or adds a path), `remove` (paths), optional
  `title` and `description`; every other base file is kept. A path both provided and removed, or a removed path the
  base lacks, is refused. Removals are a list rather than `null` per path because a multipart part cannot be `null`.
- An update whose `base_version` is not the latest answers 409 `version_conflict` with `latest_version` and commits
  nothing (VER-3).
- **Addressing:** the latest version at `/`, version `n` at `/_v/<n>/`. All versions share the artifact's origin, so a
  page's own state survives updates; that state (storage, service worker) also spans versions and can change what an
  old version shows in a browser that has it. A host per version would split that state on every update.
- **Authoring rule**, in the same words in the MCP instructions, the CLI help and the REST reference (section 8): _Link
  between an artifact's files with relative URLs (`style.css`, `img/logo.png`), percent-encoding each segment (`\` as
  `%5C`). A root-relative or absolute link to the artifact's own host loads the latest version's file when an older
  version is viewed._
- **Entry file:** `index.html` at the root, in every version (the Claude Artifacts convention). A version without it is
  refused with the message "every version needs index.html at its root" in every adapter.
- **Pruning** is not in the first release: objects are shared between versions, so removing one races with publishes.

## 5. Archive

An artifact is **archived** when its `archive` setting is `archived`, or when the setting is unset (`null`) and its
latest version is older than `ARCHIVE_AFTER_DAYS` (a deployment value, for example 30). The setting `kept` keeps it out
of the archive regardless of age.

- Set through `PATCH /v1/artifacts/{id}` with `{ "archive": "archived" | "kept" | null }`, the MCP tool `set_archive`,
  or `artifacts archive <id> on|off|auto`.
- An artifact exposes `archived` (bool) and `archive` (the setting); `archived` with `archive: null` means age decided.
- Listings take `archived=exclude` (the default), `only` or `include`; the gallery's default list excludes archived
  artifacts and `/archived` shows them.
- Archiving moves nothing in storage, creates no version, and leaves every URL, the public flag and the history as
  they are.

## 6. Files and serving

### Paths

| Rule          | Value and reason                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form          | relative, `/`-separated, no leading or trailing `/`, no empty segment: a zone with Cloudflare URL normalization merges adjacent slashes in requests, and a trailing `/` names a directory index                                                                                                                                                                                    |
| Segments      | not `.` or `..`, which URL parsing and Cloudflare's normalization remove before a request arrives; the first segment is not `_v`, which pinned versions use, nor `cdn-cgi`, which Cloudflare manages on every proxied hostname and does not pass on ([`/cdn-cgi/`](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/)); both are refused before any write |
| Characters    | any Unicode scalar value except NUL, which SQLite's string functions treat as an end; `%`, `#`, `?` and `\` are allowed, and links percent-encode them (the authoring rule)                                                                                                                                                                                                        |
| Normalization | stored and looked up in NFC: macOS file names can arrive in NFD while pages name files in NFC                                                                                                                                                                                                                                                                                      |
| Case          | case-sensitive                                                                                                                                                                                                                                                                                                                                                                     |
| Length        | at most 1 KiB of UTF-8: the whole file list is loaded on every update and returned by `get`, so 2000 paths stay near 2 MiB                                                                                                                                                                                                                                                         |

A request is resolved from the pathname the Worker receives, after URL parsing and the zone's URL normalization have
removed dot segments; the default normalization type, RFC 3986, keeps adjacent slashes, which the Cloudflare type merges
([URL normalization](https://developers.cloudflare.com/rules/normalization/how-it-works/),
[settings](https://developers.cloudflare.com/rules/normalization/settings/)), so an empty segment that arrives answers
404: split on `/`, decode each segment once with strict percent-decoding (a malformed escape or invalid UTF-8 answers
404; an encoded `/` answers 404), normalize to NFC, add `index.html` after a trailing `/`, and look the path up in the
selected version only (SRV-2). A directory with an `index.html` and no file of its own name answers 308 to the path
with `/`, and so does `/_v/<n>`; `<n>` is a canonical decimal of an existing version.

### Content types

The type given with a file, if any (`type/subtype` with parameters, at most 255 bytes); otherwise looked up from the
extension, with `; charset=utf-8` on text types and `application/octet-stream` for unknown extensions.

### Limits

| Bound                                          | Value                      | Reason                                                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST publish request body                      | 32 MiB                     | `formData()` holds the body in memory; an isolate has 128 MB and may serve several requests at once                                                                                                                                           |
| MCP request body                               | 4 MiB                      | the SDK's default; large binaries go through REST                                                                                                                                                                                             |
| REST `PATCH` body                              | 4 KiB, whitespace included | the largest valid body is under 100 bytes; the bound is counted on the raw body                                                                                                                                                               |
| Files per version and per request              | 2000                       | each new file costs up to four R2 calls (`head`, `put`, two retries) against 10,000 subrequests per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/)); equal bounds let any version be created in one request |
| Path, title, description                       | 1 KiB, 1 KiB, 16 KiB       | above                                                                                                                                                                                                                                         |
| File content returned by `read_file`           | 1 MiB                      | tool results go into the model's context                                                                                                                                                                                                      |
| Page size of a listing                         | 1 to 100, default 50       | response size                                                                                                                                                                                                                                 |
| OAuth token, registration, consent form bodies | 16 KiB, 64 KiB, 4 KiB      | the largest valid body is a few hundred bytes for a token request and the consent form, and a few KiB for a client's metadata; counted on the raw body                                                                                        |
| Wait for an R2 call, a D1 read, a KV read      | 30 s, 10 s, 10 s           | RES-2; a `put` carries up to the REST request bound, and a D1 read is an indexed lookup or a page of at most 100 rows; a KV read is one key or a page of keys. The Access key set waits 5 s (ACC-1)                                           |

A file's size is bounded by the request it travels in. The body is counted as it is read (RES-1). There is no quota and
no limit on versions.

### How bytes travel

- **MCP:** each file is `{ path, content, encoding, content_type? }`, `encoding` `"utf8"` (default; well-formed
  Unicode) or `"base64"` (RFC 4648 with padding, no whitespace).
- **REST:** `multipart/form-data`: a `meta` part with the JSON input; `meta.files[n]` gives the path and optional type
  of the n-th part named `file`. A part's file name and `Content-Type` are ignored, so no path depends on how a client
  encodes a part header; a part named other than `meta` or `file` is `invalid_request`. A `file` part must carry a
  file name all the same: without one, multipart parsing yields its content as text decoded from UTF-8, which changes
  bytes that are not UTF-8, so it is `invalid_request` before any write.

### Serving

- `Content-Type` as stored, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (a public host is its
  share link; a page can set its own policy), no CORS headers (SRV-1, ISO-2).
- `ETag` names the representation, the bytes with their type: 32 hex digits of the SHA-256 over the file's SHA-256 and
  its content type. The same bytes published again under another type get another tag, so a cached copy with the old
  type is not revalidated. The REST file route sends the same tag. Cloudflare removes the tag from artifact HTML on
  delivery, so HTML is sent in full on every revalidation ([operations.md](operations.md), section 1, "Known limit").
- `Cache-Control: private, no-cache` on private hosts and `no-cache` on public hosts, for the latest and pinned versions
  alike. Access, the public flag and existence are checked before `If-None-Match` answers 304 (SRV-3), so revoking
  access, making an artifact private or deleting it takes effect on the next request. Immutability belongs to storage,
  not to the cache.
- **Gallery assets** (section 10) are cached as immutable instead. They are not artifact files: the stylesheets, fonts
  and SVG icon are bundled with the Worker and are the same for every request that passes Access, whatever an artifact's
  visibility, so no later check could change the answer. Each is served at a fingerprinted path, its name with 16 hex
  digits of the SHA-256 of its bytes (`/assets/gallery.<hash>.css`), computed when the Worker loads, with
  `Cache-Control: private, max-age=31536000, immutable`: changed bytes get a new path, so a cached copy never goes stale
  and a reload requests none of them. Only that exact path is immutable. A page can load its assets after the next
  deployment is live, and a release before fingerprints named unhashed paths, so a path with a current asset's name and
  extension under another fingerprint (`/assets/gallery.<other>.css`) or none (`/assets/gallery.css`) answers 200 with
  the current file, `private, no-cache` and its `ETag`: the page gets today's stylesheet and fonts rather than none, and
  no browser keeps them under a path that named other bytes. The Worker holds only the deployed bytes; keeping earlier
  deployments' files would need storage that outlives a deployment. A `fonts.css` answered this way names the current
  fonts' paths, which are immutable. A path that names no current asset answers 404. `/favicon.ico` keeps its fixed URL,
  which browsers request on their own, and revalidates with the app host's `private, no-cache` and its `ETag`.
- `Vary: Accept-Encoding` on every response with a body or a validator, 200 and 304 alike: artifact files, the fallback
  icon, gallery pages and gallery assets, but not the consent page, which is `no-store` (section 10). The Workers
  runtime and Cloudflare compress by the request's
  `Accept-Encoding`, and the runtime adds no `Vary` itself (checked with `wrangler dev`), so without it a cache between
  the browser and Cloudflare could hand one client an encoding it did not ask for. Refusals, redirects and errors carry
  neither a body worth caching nor a validator, and go without it.
- `Cross-Origin-Resource-Policy: same-origin` on every response of a private content host and of the app host,
  including 304, 308 and 404, so another origin cannot load private content as a script, image, stylesheet or media
  with the owner's cookie (ISO-2). Public hosts omit it: their content needs no credential, and other sites may embed
  it.
- No `Content-Security-Policy` on artifacts: a page is the agent's code and may load from CDNs.
- `GET` and `HEAD` only (ISO-3); an unknown file answers a plain 404, except the icon below. `Range` is not supported
  in the first release, so audio and video cannot seek.
- **Icon:** browsers request `/favicon.ico` on their own. When the latest version has no `favicon.ico` (and no
  `favicon.ico/index.html`, which answers its 308), the host answers that path with the gallery's icon (section 10)
  instead of 404. The fallback comes where the 404 would: after Access, the public flag and existence, read in the same
  D1 batch as the files, so an unknown host, an unknown or deleted artifact and a private artifact on its public host
  answer as for any other file. It carries the host class's headers; its `ETag` is the icon's (the SHA-256 of its
  bytes), so it revalidates on every use like a stored file, and once a version publishes its own `favicon.ico`, the
  next revalidation gets that file with its own tag. Pinned paths have no fallback: a browser asks only at the root,
  also while it shows a pinned version, and `/_v/<n>/` serves exactly that version's files.

## 7. Auth

Agents and the CLI send a bearer credential to the API host: an OAuth access token from a grant the owner approved, or
a static API token. Browsers sign in with Access. Every credential has a **publisher name** of the form
`[a-z0-9-]{1,32}`, which becomes the `published_by` of each version it publishes and is logged with each change
(TOK-3).

### OAuth

MCP clients and the CLI sign in with OAuth 2.1 as the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
describes, so no client carries a pasted long-lived token, and hosted Claude, which cannot rely on a static header,
can connect. The authorization server is `@cloudflare/workers-oauth-provider` 1.2.4 in its `OAuthAuthorizationServer`
role ([reference](https://github.com/cloudflare/workers-oauth-provider/blob/b4cec3173079b42e3df2cb9f16a8ff13653709d0/docs/authorization-server.md)),
storing clients, grants and tokens in the KV namespace `OAUTH_KV`, its only storage. The Worker's router stays in front
of it: the host class is decided first (HOST-1), and the resource side (metadata documents, the `401` challenge,
choosing how to check a credential) is the router's.

| Endpoint                                                 | Host and path                                                   | Served by                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Authorization server metadata (RFC 8414)                 | API host, `/.well-known/oauth-authorization-server`             | the library                                                    |
| Token: code exchange, refresh, revocation (RFC 7009)     | API host, `/oauth/token`                                        | the library                                                    |
| Dynamic client registration (RFC 7591)                   | API host, `/oauth/register`                                     | the library                                                    |
| Protected resource metadata (RFC 9728), one per resource | API host, `/.well-known/oauth-protected-resource/mcp` and `/v1` | the router                                                     |
| Authorization and consent                                | app host, `/oauth/authorize`, behind Access                     | the router, with the library's parsing, consent and completion |

- **Issuer and resources.** The issuer is the API origin. There are two resources, `<API origin>/mcp` for MCP and
  `<API origin>/v1` for REST and the CLI. Every grant and every access token is bound to exactly one of them, and a
  token is refused on the other (OAUTH-3). The MCP resource is exactly the URL a client is given. Gemini CLI refuses
  protected resource metadata whose `resource` differs from its server URL
  ([source](https://github.com/google-gemini/gemini-cli/blob/4ed06ed0ddc523a6d356a4ad35ddfea331041888/packages/core/src/mcp/oauth-utils.ts)),
  and claude.ai requires the same ([authentication](https://claude.com/docs/connectors/building/authentication)). The
  library matches a requested `resource` to a configured one by its exact path, so one resource for the whole origin
  would answer `invalid_target` to every client that sends its server URL. A request without `resource`, as
  2025-03-26 clients send it, gets the MCP resource (the library's `defaultResource`).
- **An MCP sign-in reaches `/mcp` only.** For a file over 1 MiB, `read_file` names its REST URL (section 8), which
  answers 401 to the client's `/mcp` token. The supported way to such a file is a `/v1` credential: the CLI
  (`artifacts pull`, signed in with `artifacts login` or given an API token), which an agent on the owner's machine
  can run, or the file's URL in the owner's browser. One token for both resources would give up OAUTH-3.
- **Registration.** Clients identify themselves with a Client ID Metadata Document (CIMD) or register through dynamic
  registration (DCR). Both are on, and no client is pre-registered: claude.ai, Claude Code and Codex use CIMD when the
  metadata advertises it with the token endpoint method `none`, and Gemini CLI and `artifacts login` use DCR. CIMD is
  the library's option `clientIdMetadataDocumentEnabled`, which works only with the compatibility flag
  `global_fetch_strictly_public`: the flag keeps the library's fetches of client documents on public addresses, and the
  library bounds each document at 5 KB and 10 s. Pre-registration would need code that creates clients and hands their
  IDs to each client's configuration. If registrations ever cost noticeably, DCR goes off and Gemini CLI and the CLI get
  pre-registered clients (threat model, accepted risks).
- **No scopes.** A grant has full access to its resource, as an API token does (threat model, accepted risks). The
  metadata advertises none, a grant records the scopes the client asked for, and nothing checks them. Refresh tokens are
  issued without `offline_access`.
- **Off in a localhost configuration.** The library accepts plain `http` URLs for its issuer and endpoints only on
  loopback hosts (`localhost`, `127.0.0.0/8`, `::1`), not on names under `localhost`, so with the hosts of section 1's
  local development every OAuth path answers 404 and the API accepts API tokens only. Tests run the Worker with
  production-shaped hosts (Testing OAuth, below).

| Client                    | Registration                                                                                                                   | Redirect URI                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Claude Code               | its CIMD on `claude.ai`, which lists the `localhost` and `127.0.0.1` forms                                                     | `http://localhost:<port>/callback`        |
| Codex CLI                 | its CIMD on `chatgpt.com` when the metadata advertises CIMD with `none` and the callback is its default loopback one, else DCR | `http://127.0.0.1:<port>/callback`        |
| claude.ai, Claude Desktop | CIMD when advertised with `none`, else DCR                                                                                     | `https://claude.ai/api/mcp/auth_callback` |
| Gemini CLI                | DCR (`authorization_code` and `refresh_token`, method `none`)                                                                  | `http://localhost:<port>/oauth/callback`  |
| `artifacts login`         | DCR (section 9)                                                                                                                | `http://127.0.0.1:<port>/callback`        |

Sources: [Claude Code](https://code.claude.com/docs/en/mcp),
[claude.ai](https://claude.com/docs/connectors/building/authentication), Codex CLI
([MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[`oauth_client_registration.rs`](https://github.com/openai/codex/blob/0184dfa6a48f0110dd9c6835522492908e5abcf3/codex-rs/rmcp-client/src/oauth_client_registration.rs)),
Gemini CLI as above and its
[MCP servers](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md) page. The library
accepts a loopback redirect URI on any port, with the host and path as registered (RFC 8252 section 7.3); `localhost`
and `127.0.0.1` are different hosts to it. Library 1.2.4 refuses a DCR request that lists a grant type it does not
implement, such as VS Code's `device_code`; no client above lists one, and the unreleased fix (#423) narrows such a
list instead.

#### Authorize and consent

The authorization endpoint is on the app host, so the app's Access application, its audience and ACC-1 guard it and
the page reuses the gallery's template; RFC 8414 requires only the issuer to match exactly (section 3.3), and each
endpoint is its own URL. On the API host it would need an Access application on one path of a host that must otherwise
stay open, and a host of its own would need another application, audience and route for one page. A client that
refused an authorization endpoint on another host than the issuer would move it to the API host. `GET` shows the
consent page:

1. The method is checked, then Access (ACC-1), as for the gallery. The path takes `GET` and `POST`; any other method,
   `HEAD` included, answers 405, since a `GET` there writes a transaction.
2. A `client_id` that is an `https` URL on a host of this deployment (app, API, content or public) is refused before
   anything is fetched (OAUTH-6): a public artifact could otherwise serve a client document under the owner's domain.
3. The library's `parseAuthRequest` checks the client, fetching its CIMD document, then the redirect URI against the
   registered ones, PKCE and the resource. It refuses `plain` but requires a challenge only from a client that
   authenticates with `none`, so the router then requires `code_challenge` with `code_challenge_method=S256` from
   every client, answering `invalid_request` to the redirect URI otherwise (OAUTH-2). Every grant then holds a
   challenge, and the library's code exchange requires its verifier.
4. A redirect URI on a host of this deployment is refused (OAUTH-2): an artifact page there could read the code.
5. `beginConsent` stores the request in KV for 10 minutes, encrypted under a 256-bit handle, and returns the handle
   for the page and a `__Host-` cookie that binds it to this browser, with `Cache-Control: no-store` and
   `X-Frame-Options: DENY`.

The page uses the gallery's template and stylesheet (section 10, [gallery/design.md](gallery/design.md)) and escapes
every value, all of which the client chose (ISO-5). It shows:

- the client's name, with the domain of its CIMD URL, or "registered itself; the name is not verified" for a DCR
  client;
- where access is sent, the redirect URI's host, with a warning for a loopback host ("an app on this computer: allow
  only if you just started signing in from it");
- the resource, MCP or the REST API, and what the grant allows: reading, publishing, making public and deleting every
  artifact;
- a field for the publisher name, filled from the client's name (lowercased, runs of other characters turned into `-`,
  cut to 32 characters, `client` if empty), with its rule as persistent help above the input (`required`,
  `pattern="[a-z0-9\-]{1,32}"`, `maxlength="32"`, no autocorrection) and a message that `:user-invalid` reveals; the
  hidden handle; **Allow**, and **Deny** with `formnovalidate`. Without script, the browser's own validation names a
  bad value on submit, and the persistent help is the field's description. The pattern escapes its `-`: browsers
  compile `pattern` with the `v` flag, under which `[a-z0-9-]` is invalid and the browser skips the check.

`POST /oauth/authorize` takes a form of at most 4 KiB (RES-1):

- `decision=deny`: `denyConsent` consumes the transaction and redirects to the client with `error=access_denied`,
  `state` and `iss`.
- `decision=approve`: a publisher name of the wrong form is answered with an error page, leaving the transaction
  usable, so going back and correcting it works. Otherwise `approveConsent` checks the handle against this browser's
  cookie and consumes it. Approving replaces the grants the same client holds for that resource; for a CIMD client,
  only those from the same redirect URI, port included. The router finds them in the grant listing and revokes each as
  `DELETE /v1/grants/{id}` does (Revocation, below), since the library's own replacement ignores a failed deletion;
  any failure answers the 503 error page, and no code is sent. Then `completeAuthorization`, with
  `revokeExistingGrants: false`, stores the grant: user ID `owner`, since the Access policy is the one place that
  names the owner; props `{ publisher }`; metadata with the publisher name, the client's name and the redirect host,
  for listing grants. The browser is redirected to the client with `code`, `state` and `iss` (RFC 9207).

The owner names the publisher because neither alternative identifies one: a client's name is whatever it registered,
so two clients can claim the same, and a grant's ID says nothing in a version history.

The consent page's `Content-Security-Policy` is the gallery's (section 10), which carries the library's
`frame-ancestors 'none'`, with `form-action 'self' <redirect origin>`. Chrome applies `form-action` to the redirect
that answers a form post, and other browsers differ
([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action)), so
the client's origin is listed. It is the redirect URI's origin, and it is written into the header only when it is
`https://` with a DNS host, or `http://` with a loopback host, each with an optional port; any other form is refused
before the page. Every other app-host response keeps `form-action 'none'`. Consent is never remembered: a site that
navigates the owner's browser to the endpoint would otherwise skip the page.

| Failure                                                                                          | Answer                                                                              |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `parseAuthRequest` or the PKCE requirement refuses, with a validated redirect URI                | redirect to the client with `error`, `state` and `iss`                              |
| `parseAuthRequest` refuses without one; a client ID or redirect URI on a host of this deployment | an error page (400); never a redirect                                               |
| A CIMD document cannot be fetched or checked                                                     | an error page (400)                                                                 |
| The transaction expired, was used, or belongs to another browser                                 | an error page (400) asking to start again from the client                           |
| Anything else (a KV failure, a replaced grant that cannot be revoked)                            | 500 or 503 as section 8's internal and unavailable errors, logged by class (DATA-1) |

#### Tokens and lifetimes

| Item                          | Lifetime and use                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Authorization code            | 10 minutes, once, with the PKCE verifier                                           |
| Access token                  | 1 hour (the library's default)                                                     |
| Refresh token                 | rotated on every use; the previous one stays valid until the new one is first used |
| Grant                         | 30 days from the code exchange, then 30 days from each refresh (sliding)           |
| Client registered through DCR | 90 days, renewed while it is used                                                  |
| Consent transaction           | 10 minutes, once, in the browser that opened the page                              |
| Revocation record             | never expires (Revocation, below)                                                  |

Tokens, codes, client secrets and transaction handles are stored only as hashes, and a grant's props are encrypted
under keys that its tokens wrap (OAUTH-4). Expired records leave KV through their TTLs, so no scheduled cleanup runs.
The grant slides (`refreshTokenTTL` and `refreshTokenIdleTTL` of 30 days) because the owner's clients refresh daily:
a fixed lifetime would send every client through the consent page each month without a defense the purpose needs.
With rotation, once a stolen refresh token and its client have both refreshed, one of them is refused at its next
refresh, and signing in again replaces the grant; an idle grant, such as one on a retired machine, still ends after 30
days. The library has no absolute maximum for a sliding grant.

#### Revocation

- **One grant:** `DELETE /v1/grants/{id}` (`artifacts revoke <grant>`, section 9) deletes the grant and its tokens
  through the library's `revokeGrant`, whose deletion of the grant writes its revocation record first (below). A
  failure answers 503 `unavailable` and logs `grant.revoke_failed`, and a repeated call completes it.
  `artifacts grants` lists the grants, with the publisher name, the client and the redirect host of each.
- **By signing in again:** a new approval replaces the client's grants for that resource the same way (above). A
  client that picks a new loopback port per sign-in, as Claude Code and Codex do by default, or that registers anew,
  leaves its earlier grant until it is revoked or idle for 30 days; `artifacts grants` shows it.
- **From the client:** RFC 7009 at the token endpoint, handled by the library. A refresh token deletes its grant
  through `revokeGrant`, so with its record as above; an access token is revoked alone and leaves the grant.
  `claude mcp logout` revokes "where the authorization server supports revocation"
  ([Claude Code](https://code.claude.com/docs/en/mcp)); `artifacts logout` revokes its own grant through `/v1/grants`
  (section 9). A client that only deletes its tokens, as `claude mcp remove` does, leaves the grant until it is
  revoked or idle for 30 days.
- **Every grant at once:** bind a new, empty namespace as `OAUTH_KV` and deploy ([operations.md](operations.md)). A
  new version reads only the new namespace, so this takes effect at once; every client signs in again.

**The revocation record** makes every revocation final, through `/v1/grants` and RFC 7009 alike. In library 1.2.4 a
refresh or a code exchange reads the grant and later writes it back, with its new refresh token, before it stores a
new access token
([source](https://github.com/cloudflare/workers-oauth-provider/blob/b4cec3173079b42e3df2cb9f16a8ff13653709d0/src/oauth-provider.ts)),
so a deletion between the two is undone. Checking an access token reads only the token's record, not the grant, and
`revokeGrant` finds a grant's tokens through KV's listing, which can miss one written just before. The library
therefore gets `OAUTH_KV` through a narrow forwarding wrapper: every call passes through unchanged, except that
deleting a `grant:<user>:<id>` key first writes `revoked:<id>`, and deletes only once that write has succeeded, so a
failed write fails the deletion. Any write-back follows the deletion, and so the record. The router refuses every use
of a grant that has a record:

- on `/mcp` and `/v1/`, after `validateToken` accepts a credential (Checking a credential, below);
- at the token endpoint, before the library sees a request with `grant_type` `authorization_code` or `refresh_token`:
  a record for the grant its `code` or `refresh_token` names answers `invalid_grant`, as the library answers a client
  that authenticated for a grant that is gone. The router answers before the library authenticates the client, which
  it would answer 401 `invalid_client` otherwise, so a request without client authentication learns whether the grant
  ID it sent has a record: an ID it already holds, never a credential. Token exchange, the one other grant type that
  uses a grant, is off (the library's default).

Only `revokeGrant` deletes a grant key (line 7307 at the pin), so a record follows each revocation and nothing else.
Its callers are RFC 7009 with a refresh token (line 4862), a replayed code (line 3503), and this Worker's
`DELETE /v1/grants` and replacement on approval. The library's own replacement is off, no token exchange callback is
configured, and the Worker never calls `deleteClient` or `purgeExpiredData`, which would record only grants that are
unusable already; an expired grant leaves through its KV TTL, without a deletion. A failed deletion answers 503 on
`/v1/grants` and on approval, and on RFC 7009, which does not catch it: the wrapper marks a failed KV call, and the
router answers it 503 `temporarily_unavailable`, after which "the client must assume the token still exists"
([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html#section-2.2.1)) and may retry. Only the revocation after a
replayed code ignores a failure, as the library ignores every failure there.

The grant ID is the middle part of every code and token the library issues, `<user>:<grant>:<secret>`, 16 characters
the library generates; the user ID `owner` has no `:`, which the library refuses in one. The library never reads,
writes, lists or deletes a `revoked:` key: its keys start with `client:`, `grant:`, `token:`, `transaction:`,
`client-assertion-jti:` or `enterprise-jti:`. Records never expire. One is written per revoked grant: for one owner
a few a month, about a thousand in ten years, some 50 KB of the 1 GB of storage Workers Paid includes, each written
once against the million writes a month it includes
([KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)). Binding a new namespace clears them with
everything else.

**Revocation is not immediate.** KV is eventually consistent: a change "may take up to 60 seconds or more to be
visible in other global network locations", longer where the key was read just before
([how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). Until the record arrives, a revoked
grant's tokens can still work in those locations, and a refresh there can write the grant back and receive new tokens,
which the record refuses once it arrives. For the same reason a code or a refresh token presented twice at nearly the
same moment may be accepted twice, and a consent transaction may be used twice from the same browser. A stolen code is
useless without its PKCE verifier, and the previous refresh token stays valid by design (threat model, accepted risks).

#### Checking a credential

On `/mcp` and `/v1/`, the router reads `Authorization: Bearer <credential>` (TOK-1):

- A credential of the library's form, three parts joined by `:` (`<user>:<grant>:<secret>`), goes to the library's
  `validateToken` with the route's resource, `/mcp` or `/v1`. It reads the token's KV record under the KV-read timeout
  (RES-2) and checks expiry and audience; then the router reads the grant's revocation record under the same timeout
  (Revocation, above). The props give the publisher name, and the change logs also carry the grant's ID (TOK-3).
- Any other credential is an API token, compared with `API_TOKENS` as below, without reading storage. Every token
  `artifacts token` makes keeps working: `art_` and base32 characters, without `:`. A token made by hand in the
  library's form now goes to the library, which refuses it, since the router picks one check by the credential's
  form and never tries the other; such a token is regenerated with `artifacts token`.
- Neither path falls back to the other. A missing, unknown, expired, revoked or wrong-audience credential answers 401
  `unauthorized` with `WWW-Authenticate: Bearer resource_metadata="<the route's metadata URL>"`, and
  `error="invalid_token"` when a credential was sent. A KV failure or timeout answers 503 `unavailable`.

The protected resource metadata is built from the configuration: `resource`, `authorization_servers` with the issuer
alone (claude.ai uses only the first entry), `bearer_methods_supported: ["header"]` and `resource_name`. Other paths
under `/.well-known/oauth-protected-resource` answer 404. The router does not use the library's `OAuthResourceServer`
(decisions.md).

#### The library at the boundary

- Only the three API-host paths of the table reach the library's `fetch`, and only `/oauth/authorize` on the app host
  reaches its helpers. A request to them on any other host is answered as that host answers any path (HOST-1): on a
  content or public host, an artifact that holds `oauth/token` serves it like any other file.
- Every API-host method other than those a route takes, `OPTIONS` included, answers 405 before the library and
  before authentication; `OPTIONS` on a path no route takes answers 404. `Access-Control-*` headers are removed from
  the library's answers (ISO-2): the library reflects the request's `Origin` for browser clients, and no client in
  scope runs in a browser.
- The token and registration bodies are read with the counted reader, at most 16 KiB and 64 KiB (section 6), before
  the library parses them (RES-1); the library's own bound on registration is 1 MiB.
- A token request with `grant_type` `authorization_code` or `refresh_token` reaches the library only after the router
  has found no revocation record for the grant it names (Revocation, above); a KV failure or timeout there answers 503
  `temporarily_unavailable`. A code or refresh token whose grant key, `grant:<user>:<grant ID>`, would pass KV's limit
  of 512 bytes names no grant and answers `invalid_grant` the same way: the library's read of that key would throw,
  and its 503 would invite a retry that can never succeed.
- The library's errors keep their RFC 6749 and RFC 7591 bodies, `{ "error", "error_description" }`, since clients
  parse them; its `onError` hook, which would otherwise write each error's description to the console, only logs
  `oauth.refused` with the code and the library's category, each from a closed set (DATA-1). `/mcp` and `/v1/` keep
  section 8's error contract.
- The library has five `console` calls, all in `oauth-provider.ts` at the pinned commit. Three never run here: the
  default `onError` (line 1956), which the hook replaces; the warning for a missing compatibility flag (line 114),
  since the flag is set; and the warning after a failed token exchange callback (line 3355), since none is
  configured. Two `console.warn` calls have no hook to replace them, and DATA-1 names them as its exception:
  - `CIMD fetch failed for <client ID>: <message>` (line 5489), when a CIMD document cannot be fetched or checked, on
    any request naming that client ID. The client ID is the URL as the caller sent it, path and query included. The
    message is one of the library's, made of numbers, its constants, the fetch's own error, or values copied from the
    document: its `client_id` and the authentication methods it lists.
  - `Failed to renew client registration <client ID>:` with the KV error (line 5466), when renewing a DCR client's
    90-day registration fails; the client ID is the 16 random characters the library generated when it registered.

  What these lines carry is chosen by whoever sends the request or publishes the document. The first logs the client
  ID exactly as the caller sent it, so anything the caller put in its own identifier reaches the logs, a password in
  its userinfo (`https://user:password@client.example.org/client.json`) included; the library refuses such an ID, so
  no client of that ID can exist. Neither line carries another party's secret or private content: the renewal line
  names a generated ID and a KV error, and the fetch carries no credential, only `Accept`, `Cache-Control` and
  `User-Agent`, and goes to public addresses only (`global_fetch_strictly_public`), so the document is what any
  anonymous request reads at that URL; a private content host answers such a request with Access's sign-in, and the
  authorize endpoint refuses client IDs on this deployment's hosts. A URL that names a public artifact, or redirects
  to one, can put that artifact's `client_id` and method values in the line, which its link already gives to anyone.

#### Testing OAuth

- **Locally,** in the Worker's tests with D1, R2 and KV, production-shaped hosts and Access JWTs signed by the test key
  set as today: the whole MCP flow with the MCP SDK's client (a 401, both metadata documents, DCR, the consent page
  played by the test with an app-audience JWT, the code with PKCE, tool calls, refresh with rotation, RFC 7009 and
  `/v1/grants` revocation); CIMD with a stubbed fetch of the client's document; and each plan-layer row. The CLI's
  login runs against the Worker as the CLI's end-to-end test does, with the browser step injected and the Worker built
  with the test's Access verifier. That test runs on Node, since wrangler's test harness does not run under Bun
  (decisions.md); the CLI's unit tests, the lock's among them, run on Bun, the binaries' runtime. The smoke tests
  therefore run the release binary's `login`, a refresh and `logout` on macOS and Linux against a local server standing
  in for the authorization server and the API, with a stand-in for the system's opener on `PATH` playing the browser,
  and its refusal of `login` and `logout` on Windows.
- **Only on the deployment:** Access in front of the authorize endpoint, the real clients of the purpose layer, the
  delay of revocation across locations, and Workers Logs ([operations.md](operations.md), post-deployment checklist).

### API tokens

- `art_` + 32 base32 characters (160 bits), generated by the CLI's `token` command (section 9), which prints the token
  once and its entry. The secret `API_TOKENS` maps a token name (`[a-z0-9-]{1,32}`, one per agent) to the hex SHA-256
  of the token; a plain hash suffices for a random token, and about 40 entries fit in a 5 KB variable. It is a JSON
  object, `{"codex": "<64 lowercase hex>", …}`; two entries with the same hash are refused. The Worker compares the hash
  with every entry using `crypto.subtle.timingSafeEqual`
  ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)); the name is the token's
  publisher name (TOK-1, TOK-3). Revoking is removing the entry and putting the secret again, which takes effect from
  the next request.
- They stay for automation that can use neither OAuth flow: a CI job, or `claude -p` without an earlier
  `claude mcp login`. A deployment turns them off by deleting the secret or putting `{}`: with no entry, every
  credential that is not the library's is refused. A missing `API_TOKENS` is therefore valid, while a malformed one
  still answers 503 `unavailable`, so a typo fails loudly.

### Access and public links

- **Access:** two self-hosted applications, app and content, each admitting only the owner, with the
  `CF_Authorization` cookie set to HttpOnly explicitly because the documented default is inconsistent
  ([authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)).
  A wildcard host gets its cookie through a redirect on first visit, without a new sign-in. The Worker verifies
  `Cf-Access-Jwt-Assertion` as kopje does (ACC-1): an invalid JWT answers 403, a key set it cannot fetch answers 503
  `unavailable`. The Access policy is the one place that names the owner, so the Worker compares no email.
- **Public links:** every artifact has a `public` flag, off when created and set through the API
  (`PATCH { "public": bool }`, MCP `set_public`, `artifacts public <id> on|off`). Making an artifact public exposes
  its latest version and every pinned version on its public host, which serves them with section 6's rules and no
  Access; a private, deleted or unknown artifact answers the same 404 there (PUB-1).

## 8. REST API and MCP

### Operations

| Operation       | REST                                                           | MCP tool                    | Result                                            |
| --------------- | -------------------------------------------------------------- | --------------------------- | ------------------------------------------------- |
| Create          | `POST /v1/artifacts` (multipart)                               | `create_artifact`           | 201 `{ artifact, version }`                       |
| Update          | `POST /v1/artifacts/{id}/versions` (multipart)                 | `update_artifact`           | 201 `{ artifact, version }`                       |
| List            | `GET /v1/artifacts?archived=&limit=&cursor=`                   | `list_artifacts`            | `{ artifacts, next_cursor }`                      |
| Get             | `GET /v1/artifacts/{id}`, `…/versions/{n}`                     | `get_artifact` (`version?`) | `{ artifact, version }`, the version with files   |
| List versions   | `GET /v1/artifacts/{id}/versions?limit=&cursor=`               | `list_versions`             | `{ versions, next_cursor }`, without files        |
| Read a file     | `GET /v1/artifacts/{id}/versions/{n}/files/{path}` (raw bytes) | `read_file`                 | `{ path, content_type, size, encoding, content }` |
| Public, archive | `PATCH /v1/artifacts/{id}` with `public` and/or `archive`      | `set_public`, `set_archive` | `{ artifact }`                                    |
| Delete          | `DELETE /v1/artifacts/{id}`                                    | `delete_artifact`           | 204, or `{ deleted: id }`                         |

- Create takes `title`, `description?`, `files`; update takes `id`, `base_version`, `title?`, `description?`,
  `files?`, `remove?`. Pages published through REST follow the authoring rule of section 4, and a lost create response
  is followed by a listing before another create. A REST `{path}` is resolved like a request path on a content host. `read_file` reads a file by its
  exact path, so a directory path that REST answers with a 308 to its `index.html` is `not_found`; it returns `utf8`
  for textual, valid UTF-8 content and `base64` otherwise, and refuses a file over 1 MiB with `invalid_request`, naming
  the REST URL in `rest_url`. These two are where `read_file` and REST differ.
- **Delete** is logical at once: one batch writes the tombstone and removes the rows, so every URL answers 404. The
  prefix's objects are then deleted, best effort. A repeated `DELETE` of a tombstoned ID retries that cleanup and
  answers 204, like the first; an ID that never existed answers 404 (VER-4).
- **Pagination:** artifacts in `(updated_at DESC, id DESC)` order, versions in `number DESC`. The cursor is opaque and
  names the last item's key; a malformed cursor is `invalid_request`; the last page has `next_cursor: null`. Traversal
  is live, not a snapshot: an artifact created, updated, archived or deleted during it can be missed, and since
  `updated_at` never decreases, none appears twice. New versions appear before the cursor and are not repeated.
- **Grants**, REST only and only where OAuth is on (section 7; elsewhere 404): `GET /v1/grants` answers
  `{ grants: [{ id, publisher, client_id, client_name, redirect_host, resource, created_at, expires_at }] }`, every
  grant in one answer, newest first, read under the KV-read timeout (RES-2). It leaves out a grant that has a
  revocation record, since a refresh in flight can write a revoked grant back (section 7). `DELETE /v1/grants/{id}`
  revokes one as section 7 describes and answers 204, 404 `not_found` for an ID the library's listing does not hold,
  or 503 `unavailable` when a write fails. It has no timeout, since a write that timed out could still apply, and a
  repeated call completes it. Any credential the API accepts may call them. They are not MCP tools: an agent has no
  reason to manage the owner's sign-ins.

```json
{
  "artifact": {
    "id": "k2x7…",
    "title": "Quarterly chart",
    "description": "",
    "public": false,
    "archived": false,
    "archive": null,
    "latest_version": 3,
    "created_at": "2026-11-16T09:00:00.000Z",
    "updated_at": "2026-11-16T10:00:00.000Z",
    "url": "https://k2x7…-art.example.com/",
    "public_url": null,
    "gallery_url": "https://artifacts.example.com/a/k2x7…"
  },
  "version": {
    "number": 3,
    "created_at": "2026-11-16T10:00:00.000Z",
    "published_by": "codex",
    "title": "Quarterly chart",
    "description": "",
    "file_count": 3,
    "total_bytes": 48213,
    "url": "https://k2x7…-art.example.com/_v/3/",
    "files": [{ "path": "index.html", "size": 1834, "sha256": "…", "content_type": "text/html; charset=utf-8" }]
  }
}
```

### Errors

**Operation errors** come from the shared operation layer, from a closed set mapped once (P5). REST answers
`{ "error": { "code", "message", … } }` with the status below; MCP answers a tool result with `isError: true` and the
same object.

| Code               | HTTP | When                                                                                                           |
| ------------------ | ---- | -------------------------------------------------------------------------------------------------------------- |
| `invalid_request`  | 400  | input fails validation; `issues` lists `{ field, reason }`, reasons from a closed set                          |
| `not_found`        | 404  | no live artifact, version or file                                                                              |
| `version_conflict` | 409  | `base_version` is not the latest; carries `latest_version`                                                     |
| `unavailable`      | 503  | invalid configuration, an unreachable key set, or a failed or timed-out read or upload, OAuth storage included |
| `internal`         | 500  | anything else; the message carries no detail                                                                   |

**Transport and protocol errors** come before or around an operation: 401 `unauthorized` with
`WWW-Authenticate: Bearer`, which names the route's protected resource metadata where OAuth is on (section 7), 403 for
a foreign `Origin` on `/mcp` (HOST-3), 405, 413 for an oversized body and 415 for the wrong body type, in the same JSON
shape on REST and as plain HTTP answers on `/mcp`. The OAuth endpoints answer in their RFCs' shape instead
(section 7). On MCP, the SDK's own JSON-RPC
errors and its rejections of arguments that fail a tool's schema also belong here: they arrive as the SDK forms them,
so REST's `invalid_request` for the same input has no exact MCP twin.

### MCP server

- `@modelcontextprotocol/server` 2.4.0, `createMcpHandler` with its default stateless serving: one factory answers the
  2026-07-28 revision and the 2025-era revisions the SDK lists (2024-10-07 to 2025-11-25), which Claude Code, Codex CLI
  and Gemini CLI speak; `GET` and `DELETE` answer 405. The SDK checks neither hosts nor credentials, so the Worker
  checks the host, the credential and the `Origin` first, removes the `Authorization` header, then builds the handler
  for the request with a factory whose closure holds the publisher name; the credential never reaches the SDK (TOK-2).
  `McpAgent` from `agents` is not used: nothing needs sessions.
- Every `/mcp` answer carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, as the REST API's do: the
  SDK's answers, its errors (405, 406, 400) and the Worker's own refusals (401 with section 7's challenge, 403, and 503
  when a credential cannot be checked). The SDK marks an event stream `no-cache, no-transform`; the Worker keeps
  `no-transform` (`no-store, no-transform`) so no proxy buffers or recompresses the stream. It replaces the headers
  only and passes the body stream through unread, so events reach the client as the SDK writes them.
- Every tool has input and output schemas. Annotations: reads are `readOnlyHint`; `create_artifact` only adds, so it
  is not `destructiveHint`; every other change is `destructiveHint`, since an update can remove files, `set_public` can
  revoke public access, `set_archive` replaces a setting and `delete_artifact` deletes; `set_public`, `set_archive` and
  `delete_artifact` are also `idempotentHint`. Whether a client asks before a call is the owner's client
  configuration, not a control of this design.

Server `instructions`:

```text
This server publishes HTML pages ("artifacts") that the owner opens in a browser. Each artifact has its own origin;
every version needs index.html at its root.

- create_artifact: a title and files. Returns the artifact, version 1 and its URLs. If a create call returns no
  result, call list_artifacts before trying again: the artifact may exist.
- update_artifact: the artifact id and base_version, the latest version you know. Files you send replace or add a
  path, paths in remove are deleted, every other file is kept. On version_conflict, call get_artifact and redo the
  change on top of latest_version.
- Every publish makes a new version that never changes. The latest is at the artifact URL; version n stays at
  <url>/_v/n/.
- Link between an artifact's files with relative URLs (style.css, img/logo.png), percent-encoding each segment (\ as
  %5C). A root-relative or absolute link to the artifact's own host loads the latest version's file when an older
  version is viewed.
- Text files use encoding "utf8", binary files "base64". The content type follows the extension unless you give
  content_type. Paths are /-separated without empty, "." or ".." segments and do not start with "_v/" or "cdn-cgi/".
- At most 2000 files per version and about 4 MiB per call; for larger files, use the REST API or the CLI.
- Artifacts are visible only to the owner until set_public; a public artifact shows all its versions. Never put
  secrets in an artifact.
```

## 9. CLI

- **Commands:** `publish <dir> [--id <id>] [--title <t>] [--description <d>]`, `list [--archived only|include]`,
  `get <id> [--version <n>]`, `pull <id> <dir> [--version <n>]`, `public <id> on|off`, `archive <id> on|off|auto`,
  `delete <id>`, `token <name>`, `login`, `logout`, `grants`, `revoke <grant>`; `--json` prints the API's JSON, and
  `artifacts --version` alone prints the CLI's version. `list` follows every page. Configuration: `ARTIFACTS_API_URL`,
  the API origin (`http` only for `localhost` names, since the credential travels with it), and a credential:
  `ARTIFACTS_TOKEN` when it is set, otherwise the login stored for that origin, so a script that sets the token behaves
  as before. Neither is ever printed, and a 401 names both (on Windows, only `ARTIFACTS_TOKEN`, as the help does there).
  The help text carries the authoring rule.
- **`publish` without `--id`** creates (`--title` required). After a lost response (no answer, or a 5xx) it lists
  every artifact and takes the one with the same title and description, version 1 and the same files (path and
  SHA-256), creating once more only when none matches. **With `--id`** it reads the latest version, hashes local files
  with `node:crypto` `createHash` as streams, sends new and changed files, removes paths the directory lacks, and sends
  the version it read as `base_version`; a conflict is reported, not retried. In place of a directory, `publish` takes
  one `.html` or `.htm` file as the version's only file, `index.html`; any other single file is refused.
- **`pull`** writes every file of a version into a new or empty directory, so that `publish --id` from it reproduces
  the version. Each file is created exclusively and checked against its listed size and SHA-256.
- **`token <name>`** generates an API token (section 7) and prints it once with its `API_TOKENS` entry.
- **`login`** signs the CLI in with OAuth for the `/v1` resource (section 7). A device flow, for a machine without a
  browser, is not offered: the library does not implement one, and such a machine keeps an API token.
  1. It reads `<origin>/.well-known/oauth-protected-resource/v1` and requires its `resource` to be `<origin>/v1` and its
     one authorization server to be the origin itself, then reads that server's metadata, whose `issuer` must be the
     origin (RFC 8414 section 3.3) and whose token and registration endpoints must be on it; the authorization
     endpoint, which the browser opens, receives no credential. No request of `login` or of a refresh follows a
     redirect: a redirect answer fails the command. Credentials therefore go only to the origin the owner configured.
  2. On the first login for an origin it registers through DCR (`artifacts CLI`, `http://127.0.0.1/callback`, method
     `none`) and keeps the client ID; a client the server no longer knows is registered again.
  3. It listens on `127.0.0.1`, on a port the system picks, for one request to `/callback`, opens the browser at the
     authorization URL (PKCE S256, `state`, `resource=<origin>/v1`) with the system's opener (`open` on macOS,
     `xdg-open` on Linux) and prints that URL for a browser that does not open.
  4. It checks `state` and `iss` on the callback, exchanges the code and stores the tokens. The listener closes after
     the first callback, on every failure and after 5 minutes without a callback; the page it answers says only whether
     to return to the terminal.
- **Stored login:** `$XDG_CONFIG_HOME/artifacts/credentials.json` (`~/.config/artifacts/` when unset), one entry per API
  origin with the client ID, the tokens and the access token's expiry. The directory is created with mode `0700` and
  the file with `0600`, written to a temporary file beside it and renamed over it. The CLI refuses to use a file or
  directory that another user can read or write, naming the path, as OpenSSH refuses a private key. Error messages
  redact the stored tokens as they do `ARTIFACTS_TOKEN`. These checks need POSIX file modes, which Windows does not
  have (decisions.md), so a login is stored on macOS and Linux only: on Windows, `login` and `logout` refuse, naming
  `ARTIFACTS_TOKEN`, and no command reads a stored login.
- **Refresh:** an access token that expires within a minute is refreshed before the request, and a 401 to a request
  sent with a stored token refreshes once and sends that request once more, which is safe because a 401 changes
  nothing (AC-7). Every request of `login`, `logout` and a refresh waits at most 30 s.
- **The lock:** every change to the file, storing a login, a refresh or removing an entry on `logout`, happens under
  one lock, `credentials.json.lock` beside it. Without it, two processes refreshing with one token could leave the
  file holding the token the server rotated out, and the next refresh would need a new login.
  - A process takes the lock by linking a complete temporary file, holding a random owner token, its process ID and
    the host name, to that name, which fails while the lock exists. Under the lock it reads the file again, sends at
    most one request, the refresh, and writes the file. A refresh changes only the entry it read: it uses tokens
    another process stored meanwhile instead of refreshing, and stops if `logout` removed the entry. On release, the
    holder removes the lock only if it still holds its own token.
  - A waiter looks again every 100 ms for at most 75 s, longer than the refresh's 30 s, then fails, naming the lock
    file to remove when no `artifacts` command is running. A lock is never taken from a holder that may still be
    alive, however long it holds it: a paused holder that resumes writes the file as the only holder.
  - A lock whose host name is this machine's and whose process is not running (signal 0 to its process ID fails
    with `ESRCH`; `EPERM`, another user's process, counts as running) belongs to a holder that is gone, and a waiter
    removes it. It first links the lock to `credentials.json.lock.<owner token>.dead`, which fails if another
    waiter did so first; the waiter that made the link removes the lock if the link holds that token, then removes
    the link. A gone holder releases nothing and no other waiter removes that lock, so it cannot change in between,
    and two waiters never remove each other's lock. A reused process ID can make a gone holder look alive, never a
    live one look gone, so it only leaves the lock for the owner to remove.
- **`logout`** revokes exactly the stored login's grant, whose ID is the middle part of its tokens (section 7), with
  `DELETE /v1/grants/{id}` sent with its own access token, then removes the entry under the lock. It sends nothing
  after the revocation, which ends the credential it used. When the request fails, or answers 404 because the
  listing does not show a grant made moments before, the entry stays and the command fails, so running it again
  completes it; a stored login the server refuses has nothing left to revoke, and its entry is removed. Other grants
  of the CLI's client, such as one an earlier login left, are for `grants` and `revoke`.
- **`grants`** lists `GET /v1/grants`; **`revoke <grant>`** sends `DELETE /v1/grants/{id}`. Neither changes the file
  except through a refresh.
- **Directory mapping:** every regular file below the directory, by relative POSIX path in NFC. Names starting with `.`
  are skipped, so `.env` and `.git/` are never published by accident. A symbolic link is followed when its target
  resolves inside the directory, and its files are published under the link's path as well as the target's, since
  pages may reference either; a link that leaves the directory, or points to a directory on the path from the root to
  itself (a loop), is refused. The root
  `index.html`, the file count and the request bound are checked before sending; a publish over the bound is refused,
  not split into versions.
- **Distribution:** TypeScript with one runtime dependency, `oauth4webapi` for the OAuth protocol (decisions.md). Each
  release carries a single binary per platform (macOS arm64, Linux x64 and arm64 with glibc, Windows x64), compiled by
  `bun build --compile` with the root package's version inlined and the dependency bundled, with `SHA256SUMS`; it
  installs with mise's github backend. From a checkout, Bun runs the source after `pnpm install`, put on `PATH` by a
  symbolic link. There is no npm package.

## 10. Gallery

Server-rendered on `APP_HOST`, without script or frames, and without forms except the consent page; the screens follow
[gallery/design.md](gallery/design.md).

| Page        | Shows                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`         | Artifacts that are not archived, in the API's order, 50 per page with a link to the next: title, start of the description, update time, latest version, public, links                                |
| `/archived` | The same for archived artifacts, with why each is archived (setting or age)                                                                                                                          |
| `/a/<id>`   | Title, description, URLs, public and archive state; the version history, newest first and 50 per page, with time, `published_by`, title, file count, size and pinned URL; the latest version's files |

A deleted artifact and any other path answer 404. Artifact text is escaped and the CSP forbids scripts and framing
(ISO-5). The gallery links to artifacts rather than framing them: Access's behavior in frames is not documented.

A page is `private, no-cache` with an `ETag`: 32 hex digits of the SHA-256 of its rendered bytes, so a matching
`If-None-Match` answers 304 with the 200's headers (CSP, CORP, `nosniff`, referrer policy, `Cache-Control`). The tag
covers everything the page shows, the archive counts, links and relative times included, which no stored timestamp
would: a page with the same data an hour later reads differently. The Worker renders the page before it compares, after
Access (ACC-1) and a successful query, so a 304 skips no check (SRV-3) and saves only the transfer; a refusal, a 404 and
a failed read carry no tag.

Every page's header shows the gallery's icon and the wordmark, one link to `/`, then the release version, the root
`package.json`'s, built into the Worker ([gallery/design.md](gallery/design.md), "Icon" and "Behavior the static design
does not show").

Every page links its stylesheets, preloads the fonts it uses ([gallery/design.md](gallery/design.md), "Ground rules")
and links the gallery's icon ([gallery/design.md](gallery/design.md), "Icon"): `icon.svg` at its fingerprinted path
(section 6), and `/favicon.ico` for browsers that take no SVG icon. `/favicon.ico` is a real ICO file rather than SVG
content: Safari reads SVG icons only from version 26 ([caniuse](https://caniuse.com/link-icon-svg)), and no browser
documents taking SVG at that path. The SVG is cached as immutable like the other assets and `/favicon.ico` revalidates
(section 6); the CSP's `img-src 'self'` lets both load, since Firefox applies `img-src` to a page's icon.

**The consent page** (section 7) is the app host's one form and a new screen of the design system. Its text field,
buttons and notice are new components, so it goes through [gallery/design.md](gallery/design.md)'s change rule: the
design file (`gallery/gallery.pen`) first, then the tokens, the stylesheet and the reference pages,
`reference/consent.html` and `reference/consent-error.html`, with the ground rule "no forms" naming this form as its
one exception. The other ground rules hold: dark only, text that scales with the user's setting, no script. The header
carries the brand alone, since the gallery's tabs show counts from D1. The page shows the client and the request as an
`info` list, the publisher name with its label, help and message, then **Allow** and **Deny**; the field and the
buttons take the focus ring links take. Its error page has the same frame, and every value on both is escaped by the
gallery's template (ISO-5).

The consent page is the one page of the app host without the pages' caching: it, its error pages and the redirects
that end it are `Cache-Control: no-store` without `ETag` or `Vary`, as the library's consent helpers make theirs. Each
`GET` begins a new transaction with its own handle and cookie, so the page's bytes never repeat and a tag would never
match, and the handle, which opens the transaction with that cookie, stays out of every cache. With nothing stored,
`Vary` has nothing to select, as on the API's `no-store` answers.

## 11. Operations

The steps are in [operations.md](operations.md).

- **Configuration split:** `packages/worker/wrangler.jsonc` (public) holds bindings (`DB`, `FILES`, `OAUTH_KV`), the
  compatibility flag `global_fetch_strictly_public` (section 7), migrations and observability with invocation logs
  off. The deployment values, in the form of `wrangler.deploy.example.jsonc`, hold the account, routes, custom domains,
  database, bucket and KV namespace identifiers, and the variables `APP_HOST`, `API_HOST`, `CONTENT_HOST_SUFFIX`,
  `PUBLIC_HOST_SUFFIX`, `ARCHIVE_AFTER_DAYS`, `ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD` and `ACCESS_CONTENT_AUD`; they
  live in the build variable `ARTIFACTS_DEPLOY_JSONC` on Workers Builds or in the gitignored `wrangler.deploy.jsonc` on
  the owner's machine. `API_TOKENS` is an optional secret (section 7). The deployment script (`scripts/deploy.ts`)
  checks the values with the Worker's own parser, merges them, checks that the bucket and the KV namespace exist,
  applies the D1 migrations on every deploy and runs `wrangler deploy` (DATA-2). The namespace is checked like the
  bucket because Wrangler provisions a resource for a binding without an ID, and its documentation does not say what a
  wrong ID does ([configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), "Automatic
  provisioning"); a new, empty namespace would sign every client out.
- **OAuth storage:** one KV namespace, bound only as `OAUTH_KV`, which the library requires. A Worker without the
  binding answers 503 `unavailable` on every host outside a `localhost` configuration, as for an invalid variable: a
  deployment never runs with OAuth silently off. Its records expire through their TTLs. Workers Paid includes 10
  million KV reads and 1 million writes a month ([KV pricing](https://developers.cloudflare.com/kv/platform/pricing/));
  a request with an OAuth token costs two reads, its token and its grant's revocation record, and a sign-in or a
  refresh a few writes.
- **Releases:** `main` is never deployed. release-please keeps a release PR open; merging it tags a version as a
  draft release, a workflow builds the CLI binaries, attaches them and publishes it, then fast-forwards the `release`
  branch to it, and Workers Builds deploys `release` only.
- **Cloudflare setup by the owner:** the proxied wildcard DNS record, the two Access applications, the D1 database, a
  private R2 bucket and the KV namespace, on Workers Paid.
- **Logging:** `logEvent` only, with closed fields; every change logs its publisher name, and an OAuth credential's
  grant ID, so the 7 days of Workers Logs show what a leaked credential did (DATA-1). OAuth adds `grant.created`
  (publisher, grant, resource, CIMD or DCR), `grant.revoked` (grant, written by the KV wrapper with each record, so
  an RFC 7009 sign-out is logged too), `grant.revoke_failed` (grant, error class),
  `consent.refused` and `oauth.refused` (reason codes, `revoked` for the token endpoint's refusal of a revoked grant),
  and `token.refused` takes the reasons `oauth` for an OAuth credential that `validateToken` refuses and `revoked` for
  one whose grant has a revocation record; the library's own two lines are in section 7.
- **No backup of bytes or OAuth storage.** Artifacts are agent output that can be produced again; deletion with a
  leaked credential is answered by revoking it. Lost grants cost each client one sign-in. D1 Time Travel restores
  metadata for 30 days ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)), which covers
  damaged rows only. Old artifacts are archived (section 5), not moved.

## Not in the first release

Version pruning (section 4), `Range` (section 6), splitting a large CLI publish (section 9), gallery previews and
search (section 10), backups of bytes (section 11).

## Purpose layer: acceptance criteria

Sources are the agreed scope: **Interfaces** (MCP and REST from one implementation, a thin CLI), **Auth** (Access for
browsers, bearer tokens for agents, public links), **Domain** (a host per artifact), **Features** (publish, read, list,
delete; version history; multiple files; gallery; archive), and **OAuth** (issue #14: MCP clients and the CLI sign in
with OAuth, every version keeps its publisher, static tokens stay as a fallback a deployment can turn off, and only the
owner grants access). Each is checked on the deployed Worker with real clients and a browser; copies a browser already
downloaded are out of scope.

| ID    | Requirement (EARS)                                                                                                                                                                                                                                    | Source                            | Scenario; pass and failure                                                                                                                                                                                                                                                                                                                                                                                                        | Checked on                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| AC-1  | When an agent calls `create_artifact` over MCP with a title and an `index.html`, the system shall return a URL that shows that page.                                                                                                                  | Interfaces; Features              | Claude Code, Codex CLI and Gemini CLI, each with `/mcp` and its own credential, publish a page. Pass: the URL renders after Access sign-in. Fail: no connection, a tool error, no page                                                                                                                                                                                                                                            | each client; a browser               |
| AC-2  | When the CLI publishes a directory, the system shall serve every file it sends, and the CLI shall skip names starting with `.` and refuse links that leave the directory.                                                                             | Interfaces; Features (files)      | `index.html`, a stylesheet, a script, a PNG, a `.env`, a link inside and one outside. Pass: the page renders with its assets and types; `.env` absent; the outside link refused                                                                                                                                                                                                                                                   | the CLI; a browser                   |
| AC-3  | When an agent updates an artifact whose pages follow the authoring rule, the system shall serve the new version at its URL and every earlier version at its pinned URL.                                                                               | Features (version history)        | Two updates through MCP. Pass: `/` shows version 3, `/_v/1/` and `/_v/2/` theirs, each with its own files. Fail: a version changed or missing                                                                                                                                                                                                                                                                                     | a real MCP client; a browser         |
| AC-4  | When an agent lists, reads or deletes artifacts over MCP, the system shall answer with their stored state, and after a delete every URL shall answer 404.                                                                                             | Features (list, read, delete)     | List, `get_artifact`, `read_file`, `delete_artifact`, then reload the old URLs. Fail: stale content or a URL that still serves                                                                                                                                                                                                                                                                                                    | a real MCP client; a browser         |
| AC-5  | When the owner browses the gallery, the system shall list every artifact and version across pages, and offer nothing that changes state.                                                                                                              | Features (gallery)                | More than 50 artifacts and an artifact with more than 50 versions. Pass: every one reachable through the page links; no forms or scripts                                                                                                                                                                                                                                                                                          | a browser                            |
| AC-6  | While a browser is not signed in to Access as the owner, the system shall serve neither the gallery nor a private artifact.                                                                                                                           | Auth (Access)                     | A private window; another identity. Pass: sign-in, then denial. Fail: any artifact byte or gallery entry                                                                                                                                                                                                                                                                                                                          | a browser                            |
| AC-7  | If a request to the REST API or `/mcp` carries no valid credential, then the system shall answer 401, naming the route's resource metadata, and change nothing.                                                                                       | Auth (tokens); OAuth              | `curl` without a credential, with a wrong and a revoked API token, and with an OAuth access token for the other resource, on each route; the `WWW-Authenticate` header names `/.well-known/oauth-protected-resource/mcp` or `/v1`                                                                                                                                                                                                 | `curl`                               |
| AC-8  | While an artifact page runs in the owner's browser, the system shall not let its script read, or load as a subresource, another artifact, the gallery, the API or its Access cookie.                                                                  | Domain                            | A probe artifact A fetches artifact B, the gallery and the API, loads B's script with `<script src>`, reads `document.cookie` and B's storage. Pass: all fail while B loads its own script                                                                                                                                                                                                                                        | a browser                            |
| AC-9  | When the owner makes an artifact public, the system shall serve all its versions at its public URL without sign-in, and when made private, the next request shall answer 404.                                                                         | Auth (public links)               | `public on`, open the latest and a pinned URL in a private window, `public off`, reload                                                                                                                                                                                                                                                                                                                                           | the CLI; a private window            |
| AC-10 | If two agents update one artifact from the same version, then the system shall commit one update and answer the other with a conflict.                                                                                                                | Features (version history)        | Two CLI publishes held at a barrier after both read the same latest version, then released. Pass: one new version, one `version_conflict`, no mixed files                                                                                                                                                                                                                                                                         | two CLI processes                    |
| AC-11 | When a client initializes `/mcp`, the system shall return the instructions of section 8.                                                                                                                                                              | Interfaces (MCP)                  | Read the returned instructions. Smoke check: an agent given only the server publishes a multi-file page and updates it, and both URLs render with their own files                                                                                                                                                                                                                                                                 | a real MCP client                    |
| AC-12 | When a script uses the REST API to create, update, read and delete an artifact, the system shall give the results the MCP tools give.                                                                                                                 | Interfaces (REST)                 | `curl` with multipart create and update, `GET` of a file's bytes, `DELETE` twice (204 both times)                                                                                                                                                                                                                                                                                                                                 | `curl`; a browser                    |
| AC-13 | When the owner archives an artifact, the system shall move it from the gallery's default list to the archived view and keep every URL serving.                                                                                                        | Features (archive)                | `archive <id> on`, then `auto`; browse `/`, `/archived` and the artifact URLs. Fail: a URL changes or the artifact is in the wrong list                                                                                                                                                                                                                                                                                           | the CLI; a browser                   |
| AC-14 | When the owner adds `/mcp` to Claude Code or Codex CLI without a credential and signs in, the system shall show its consent page behind Access and, once the owner allows, serve the client's tool calls with tokens the client stores and refreshes. | OAuth (MCP clients)               | Claude Code: `claude mcp add` without `--header`, then `claude mcp login artifacts`; Codex CLI: the URL without `bearer_token_env_var`, then `codex mcp login artifacts`. The page names the client, its domain and the loopback redirect. Pass: the nine tools, a published page, and a call more than an hour later served without a new sign-in. Fail: no consent page, a client error, a sign-in per hour                     | Claude Code; Codex CLI; a browser    |
| AC-15 | Where a client registers through CIMD or DCR, when the owner connects claude.ai or Gemini CLI to `/mcp` and allows it, the system shall serve its tool calls.                                                                                         | OAuth (hosted Claude, Gemini CLI) | claude.ai: a custom connector with the URL, connected and allowed; Gemini CLI: `httpUrl` without `headers`, then `/mcp auth artifacts`. Pass: each lists and calls the tools. A refusal is recorded with the step (discovery, registration, consent, token) and the client's version; one caused by the client is a known limit, one caused by the server a failure                                                               | claude.ai; Gemini CLI; a browser     |
| AC-16 | When the owner runs `artifacts login` on macOS or Linux and allows the CLI, the CLI shall store its credentials readable by the owner only and use and refresh them for every command until `artifacts logout`.                                       | OAuth (the CLI)                   | `login`; the file's mode is `0600`; `list` without `ARTIFACTS_TOKEN`; once the access token has expired, two `publish` to two artifacts started together both succeed, and an hour later `list` still works without a new login; `logout`; `list` fails, naming `login`; `grants` with an API token no longer shows the CLI's grant                                                                                               | the CLI; a browser                   |
| AC-17 | When a client publishes with an OAuth grant, the system shall record the publisher name the owner gave the grant as the version's `published_by`, and log it with the grant's ID.                                                                     | OAuth (publisher)                 | Allow Claude Code as `claude-code` and publish. Pass: the gallery's version history shows `claude-code`; `artifact.created` carries it and the grant's ID. Fail: another name, or none                                                                                                                                                                                                                                            | Claude Code; a browser; Workers Logs |
| AC-18 | While `API_TOKENS` holds entries, the system shall accept those tokens on `/mcp` and `/v1/` beside OAuth, and when the deployment puts `{}` or deletes the secret, it shall refuse every API token.                                                   | OAuth (static fallback)           | `curl` with an API token; put `{}`; the same call answers 401 while an OAuth client still works; put the entries back                                                                                                                                                                                                                                                                                                             | `curl`; Claude Code                  |
| AC-19 | If anyone but the owner opens the authorization URL, then the system shall not show the consent page; and if a client's redirect URI or client ID names a host of this deployment, the system shall refuse it before any consent.                     | OAuth (owner grants)              | The URL of AC-14 in a private window, signed in as another identity: Access denies. A client registered through DCR with a redirect URI on a public host: the authorization URL answers an error page and never redirects                                                                                                                                                                                                         | a browser; `curl`                    |
| AC-20 | When the owner revokes a grant, the system shall refuse its access and refresh tokens, and the client shall need to sign in again.                                                                                                                    | OAuth (revocation)                | `GET /v1/grants`, then `DELETE /v1/grants/{id}` for Claude Code's grant, with `curl` (or the CLI's `grants` and `revoke` once they ship), then a tool call every 10 s. Pass: refused within 5 minutes, this project's threshold, since Cloudflare documents no bound on KV's propagation; the delay recorded (section 7); then `/mcp` asks for sign-in and the grant stays out of the listing. Fail: still served after 5 minutes | `curl`; Claude Code                  |

## Plan layer

Claims derived from the purpose layer, each checked without the deployed Worker (unit tests, or the Worker in the
local runtime with D1, R2 and KV). A row naming a threat-model ID claims that invariant; the invariant's text is there.
OAuth rows run the Worker with production-shaped hosts and the test Access key set (section 7, "Testing OAuth").

| ID    | Claim (EARS)                                                                                                                                                                                                                                                                                                                                                | Source                    | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PL-1  | The Worker shall classify hosts as HOST-1 states.                                                                                                                                                                                                                                                                                                           | HOST-1                    | hosts with an extra label, uppercase, 25- and 27-character prefixes, a port, a hyphen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PL-2  | If a configuration value weakens a boundary, then the Worker and the deployment script shall refuse it.                                                                                                                                                                                                                                                     | HOST-2, ACC-2             | one case per refusal, for both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PL-3  | When an app or private content request arrives, the Worker shall apply ACC-1.                                                                                                                                                                                                                                                                               | ACC-1, ISO-4              | missing JWT, bad signature, other issuer, other class's audience, missing `exp`, expiry at the tolerance edges, `alg` other than RS256, unknown `kid` refreshing once, key endpoint down (503), JWT only as a cookie                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PL-4  | While the configured hosts are not all `localhost` names, the Worker shall verify Access.                                                                                                                                                                                                                                                                   | ACC-2                     | production-shaped hosts without a JWT                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PL-5  | When an API request arrives, the Worker shall apply TOK-1 on every REST route and `/mcp`.                                                                                                                                                                                                                                                                   | TOK-1                     | no header, another scheme, unknown and removed tokens; nothing changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PL-6  | If `/mcp` receives an `Origin` other than the API host's origin, then the Worker shall answer 403.                                                                                                                                                                                                                                                          | HOST-3                    | foreign, `null` and matching origins; no `Origin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PL-7  | When a version is committed or an artifact changed, the system shall record or log the publisher name, and an OAuth grant's ID.                                                                                                                                                                                                                             | TOK-3                     | publishes with two tokens and with a grant; change logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PL-8  | The Worker shall keep DATA-1 on every route and failure path.                                                                                                                                                                                                                                                                                               | DATA-1, TOK-2             | log redaction with markers; source check of the `console` sink; at the MCP handler boundary, the request and factory context carry no `Authorization` header or token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PL-9  | When a content host is requested, the Worker shall serve only its artifact's files.                                                                                                                                                                                                                                                                         | ISO-1                     | two artifacts with the same path and different bytes; a deleted ID offered again by a stubbed generator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PL-10 | The Worker shall send no `Access-Control-Allow-*` header, and `Cross-Origin-Resource-Policy: same-origin` on every private content and app response.                                                                                                                                                                                                        | ISO-2                     | every route and status (200, 304, 308, 404); public host responses without it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| PL-11 | If a request to the app host or a content host uses a method other than GET or HEAD, then the Worker shall answer 405, except that `/oauth/authorize` serves GET and POST only; it shall set no cookie but the consent binding there.                                                                                                                       | ISO-3, ISO-4              | each method on each host class; `HEAD` and `PUT` on `/oauth/authorize`; `Set-Cookie` on every route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PL-12 | When the gallery renders artifact text, the Worker shall apply ISO-5.                                                                                                                                                                                                                                                                                       | ISO-5                     | markup and attribute breakouts in titles, descriptions and paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PL-13 | When a file is served, the Worker shall send the headers of section 6.                                                                                                                                                                                                                                                                                      | SRV-1, section 6          | per host class, latest and pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PL-14 | If an artifact became private, was deleted or the request lacks access, then a matching `If-None-Match` shall not yield 304.                                                                                                                                                                                                                                | SRV-3                     | the three cases, latest and pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PL-15 | When a segment is decoded, the decoder shall accept exactly one strict percent-decoding and refuse an encoded `/`.                                                                                                                                                                                                                                          | SRV-2                     | over strings: malformed escapes, invalid UTF-8, `%2F`, `%25`, `%23`, `%3F`, NFD to NFC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PL-16 | When a `Request` reaches a content host, the Worker shall select the version and file of SRV-2 and section 6.                                                                                                                                                                                                                                               | SRV-2                     | real `Request` objects: latest and pinned paths, names with `%`, `#` and `?`, a directory (308), `/_v/<n>` (308), `_v/0`, `_v/01` and one past the latest (404); never a fallback to the latest; dot segments (`/_v/2/../index.html`) and doubled slashes, asserting the version and path served                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PL-17 | When the public host serves an artifact, the Worker shall apply PUB-1.                                                                                                                                                                                                                                                                                      | PUB-1, PUB-2              | identical 404s; pinned versions while public; 404 on the request after `public off`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PL-18 | If a publish fails before its commit or its batch rolls back, then no version shall be visible; if its response is lost after the commit, the version and its objects shall remain.                                                                                                                                                                         | VER-2                     | a failure at each upload, an upload timeout, a failing batch; a create and an update whose commit succeeds and whose response is dropped: the objects remain, a listing finds the create, and a retried update answers `version_conflict`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PL-19 | If `base_version` is not the latest or the artifact was deleted meanwhile, then an update shall commit nothing.                                                                                                                                                                                                                                             | VER-3                     | stale base; two concurrent updates from one base; a delete between upload and commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PL-20 | When files are stored, their keys and earlier versions shall satisfy VER-1 and VER-4.                                                                                                                                                                                                                                                                       | VER-1, VER-4              | R2 and D1 contents after publishes that share and change files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PL-21 | When a publish provides the same bytes twice or bytes already stored, the system shall write each object at most once, retrying R2's 429 at most twice.                                                                                                                                                                                                     | section 3                 | two paths with equal bytes; an existing object; a stubbed 429 once and three times                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PL-22 | When an artifact is deleted, every URL shall answer 404 at once; when the cleanup succeeds, its prefix shall hold no object that landed before the cleanup; a repeated delete shall remove objects that landed later and answer 204.                                                                                                                        | VER-4                     | URLs after delete; the prefix after cleanup; an injected cleanup failure, then a second `DELETE`; an upload started before the delete that lands after the cleanup, removed by a second `DELETE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PL-23 | When an update omits, removes or provides paths, the new version shall hold section 4's merge, and a version without `index.html` shall be refused with its message.                                                                                                                                                                                        | section 4                 | table of update cases, through REST and MCP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PL-24 | If an input exceeds a bound of section 6, then the system shall refuse it before any write.                                                                                                                                                                                                                                                                 | RES-1                     | at and one past each bound in its unit; a chunked body without `Content-Length`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PL-25 | If the key fetch, an R2 call or a D1 read exceeds its timeout, then the request shall answer 503, and a publish shall not have committed.                                                                                                                                                                                                                   | RES-2                     | stubbed slow key endpoint, R2 and D1 reads; the commit has no timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PL-26 | When an input passes both adapters' schemas, REST and MCP shall return the same result or operation error code, except for `read_file`'s directory paths and files over 1 MiB (section 8).                                                                                                                                                                  | P5, section 8             | one table of cases through both adapters, a directory path pinning the `read_file` difference; the file over 1 MiB checked on its own; schema rejections checked separately per adapter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PL-27 | When a client speaking 2025-03-26, 2025-06-18, 2025-11-25 or 2026-07-28 lists and calls tools, `/mcp` shall serve it, and `GET` shall answer 405.                                                                                                                                                                                                           | section 8                 | the SDK's client against the local Worker, per revision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PL-28 | When a listing is paged, the system shall follow section 8's order and cursor contract.                                                                                                                                                                                                                                                                     | section 8                 | order ties on `updated_at`; `next_cursor: null` at the end; a malformed cursor; an artifact updated mid-traversal is not repeated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PL-29 | When an artifact's archive setting or age changes, the system shall report and filter it as section 5 states, and change no version or URL.                                                                                                                                                                                                                 | section 5                 | `archived`, `kept` and unset with an injected clock either side of `ARCHIVE_AFTER_DAYS`; each `archived=` filter; URLs and versions unchanged; an archive change during an in-flight update; an update whose clock is behind the stored `updated_at`; the filter applied before pagination                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PL-30 | When the CLI maps a directory, it shall follow section 9.                                                                                                                                                                                                                                                                                                   | section 9                 | dot names, a directory, an alias link to it and pages referencing both paths, a link outside, a link to an ancestor (refused), NFD names, an unchanged file not sent, `base_version` equal to the version read; a file named with `\`, `#` and `?` sent by the CLI and served at its percent-encoded path; multi-page `list`, with and without `--json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PL-31 | The repository's `wrangler.jsonc` shall set no variable, route or account identifier.                                                                                                                                                                                                                                                                       | DATA-2                    | source check of the file and the deployment example                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PL-32 | If a path's first segment is `_v` or `cdn-cgi`, then a publish shall be refused before any write.                                                                                                                                                                                                                                                           | section 6                 | create and update through REST and MCP; D1 and R2 unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PL-33 | When a browser host is asked for `/favicon.ico` of a visible artifact whose latest version lacks it, the Worker shall answer with the gallery's icon, and otherwise as for any other file.                                                                                                                                                                  | section 6                 | the icon and its headers per host class, its 304 and HEAD; the artifact's own file winning and a revalidation after it is published; a `favicon.ico` directory; a pinned path; an unknown host, an unknown or deleted artifact and a private one on its public host answering as before; no icon or 304 without Access, after `public off` or a delete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PL-34 | When an MCP client without a credential calls `/mcp`, the Worker shall answer 401 naming its resource metadata, and the client shall complete discovery, DCR, consent, the code exchange with PKCE, tool calls and a refresh.                                                                                                                               | AC-14, OAUTH-1 to OAUTH-3 | the MCP SDK's client, per revision from 2025-06-18; both metadata documents with section 7's values; a 2025-03-26-style request without `resource` bound to `/mcp`; the consent page played by the test with an app-audience JWT                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PL-35 | When a CIMD client authorizes, the Worker shall fetch its document only when its host is not one of this deployment's, and show its domain.                                                                                                                                                                                                                 | OAUTH-6                   | a stubbed document on an outside host; a client ID on each host class refused with no fetch; an unreachable or invalid document answering an error page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PL-36 | If a redirect URI is not one the client registered, or names a host of this deployment, or the request lacks an S256 PKCE challenge, then the Worker shall not redirect with a code, whether the client is public or confidential.                                                                                                                          | OAUTH-2                   | DCR clients with redirect URIs on each host class; `localhost` against `127.0.0.1`; another path; another loopback port accepted; `state` and `iss` on every redirect; for a public (`none`) and a confidential (`client_secret_basic`) client each, a missing challenge and `plain` refused before consent, an S256 challenge that does not match the verifier refused at the exchange, and a valid one exchanged                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PL-37 | When the consent form is posted, the Worker shall create a grant only with an app-audience Access JWT, the page's handle and this browser's cookie, once.                                                                                                                                                                                                   | OAUTH-1, ACC-1            | no JWT; the content audience; no cookie; another transaction's cookie; a handle used twice; an expired one; Deny redirecting `access_denied`; two `GET`s create two transactions and no grant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| PL-38 | When the consent page renders, the Worker shall escape every client-supplied value and send the CSP of section 7, and shall refuse a redirect origin of another form before the page.                                                                                                                                                                       | ISO-5, OAUTH-2            | markup in the client's name and URI and in the redirect path; loopback and `https` origins in `form-action`; userinfo, a non-loopback `http` origin and quote or semicolon characters refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| PL-39 | If the publisher name is not of the form `[a-z0-9-]{1,32}`, then the Worker shall create no grant and keep the transaction usable.                                                                                                                                                                                                                          | TOK-3, section 7          | empty, 33 characters, uppercase, a space; then a valid name with the same handle succeeds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PL-40 | When a credential is checked, the Worker shall accept an OAuth access token only for its resource and an API token only when listed, neither falling back to the other, before any D1 or R2 call.                                                                                                                                                           | TOK-1, OAUTH-3, RES-2     | a `/mcp` token on `/v1/` and the reverse; expired, revoked and unknown three-part tokens; a token whose grant has a revocation record; an API token of the three-part form refused; an API token is never sent to KV; KV failing and slow (503) for the token and for the record; no D1 or R2 call on a refusal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PL-41 | When a grant is revoked through `/v1/grants`, RFC 7009 with its refresh token, or a new approval for the same client and resource, the Worker shall refuse every later use of it, even by a refresh or code exchange that read the grant before the deletion, and answer a failed write with an error; RFC 7009 with an access token shall leave the grant. | OAUTH-5                   | each path; the listing before and after; `DELETE` of an unknown ID (404) and repeated (404); for `DELETE`, a re-approval and RFC 7009 alike: a KV wrapper with barriers around a refresh's, and a code exchange's, read and write of the grant, the grant revoked between them, then released, after which the tokens it returned are refused on `/mcp`, on `/v1/` and at the token endpoint and the grant stays out of the listing; an injected failure of the record's write (503, the grant not deleted, a retry revokes it) and of the deletion after it (503, the grant already refused, a retry deletes it); no record written when a token or a consent transaction is deleted                                                                                                                                                  |
| PL-42 | KV shall hold no access token, refresh token, code, PKCE verifier, client secret or consent handle in clear.                                                                                                                                                                                                                                                | OAUTH-4                   | with each record live and asserted to exist before the search, every key and value searched for the credentials it involves: a pending consent transaction (its handle), an issued code not yet exchanged (the code and its verifier), the tokens after the exchange and after a refresh (both tokens, the previous refresh token), and a confidential client's registration (its secret)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PL-43 | The Worker shall invoke the OAuth library only for the API host's three OAuth paths and the app host's `/oauth/authorize`, and no answer shall carry `Access-Control-*`; `OPTIONS` to an API route shall answer 405, and on a path no route takes 404.                                                                                                      | HOST-1, ISO-2             | each OAuth path on each host class with the library's entry points spied on, called only there; the app host's other OAuth paths 404; an artifact holding `oauth/token` and `.well-known/oauth-authorization-server` serves both on its content host and, made public, on its public host; requests with an `Origin`; `OPTIONS` on each API path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PL-44 | If an OAuth body exceeds its bound of section 6, then the Worker shall answer 413 before the library reads it.                                                                                                                                                                                                                                              | RES-1                     | at and one past each bound; a chunked body without `Content-Length`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PL-45 | The Worker shall keep DATA-1 on every OAuth path and failure.                                                                                                                                                                                                                                                                                               | DATA-1, TOK-2             | log redaction through each endpoint and refusal, every `console` method captured, with markers in tokens, codes, verifiers, handles, client names, client-ID paths and queries, the client document's fields and thrown error messages (KV, fetch): a marker appears only where section 7 says the library's two lines put it; the `onError` hook logs `oauth.refused` only                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PL-46 | While `API_TOKENS` is missing or `{}`, the Worker shall refuse every API token and serve OAuth; a malformed value shall answer 503.                                                                                                                                                                                                                         | TOK-1, section 7          | the three states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PL-47 | Outside a `localhost` configuration, a Worker without `OAUTH_KV` shall answer 503 on every host; in one, every OAuth path shall answer 404.                                                                                                                                                                                                                 | section 11, ACC-2         | both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PL-48 | If the deployment values lack a KV namespace ID of 32 lowercase hexadecimal characters, as wrangler prints it, or the namespace does not exist, then the deployment script shall stop before the migrations.                                                                                                                                                | DATA-2, section 11        | each refusal; a stubbed namespace listing without the ID                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PL-49 | When the CLI logs in, it shall send credentials only to the configured origin, accept one callback on `127.0.0.1` for at most 5 minutes, check `state` and `iss`, and store the tokens in a `0600` file; if it runs on Windows, then it shall refuse `login` and `logout` and ignore any stored credentials file.                                           | AC-16                     | the CLI against the Worker built with the test's Access verifier, the browser step injected: metadata naming another issuer or resource refused; metadata with the right issuer and a token or registration endpoint on another origin refused; a redirect from either metadata document, the registration or the token endpoint refused, not followed; a wrong `state` or `iss` refused; the listener closed after the timeout and on failure; file and directory modes; a group-readable file refused; in the smoke tests, the release binary's `login`, a refresh and `logout` on macOS and Linux and on Windows its refusal of `login` and `logout`, and `list` with `ARTIFACTS_TOKEN` ignoring a credentials file placed beforehand                                                                                               |
| PL-50 | When CLI processes change the stored login at once, the CLI shall make the changes one at a time under its lock, never take the lock from a holder that may be alive, and follow a 401 with exactly one refresh and one retry.                                                                                                                              | AC-16                     | CLI processes held at barriers: two with an expired access token refresh once and both succeed; a refresh delayed 20 s while another waits, which then uses its tokens, and one delayed past 30 s, aborted with the lock released and the file as it was; a holder stopped between its last read and its rename while a waiter tries to recover the lock and runs out its 75 s: the waiter fails naming the file and leaves the lock, and the resumed holder writes and releases; a gone process's lock removed by exactly one of two waiters at once; the lock of a running process, of another host, or of a reused process ID never removed; `login` and `logout` each racing a refresh: the login's tokens stored, the removed entry not written back; a 401 answered by exactly one refresh request and one replay of the request |
| PL-51 | When `ARTIFACTS_TOKEN` is set, the CLI shall use it and not read the stored login, and `logout` shall remove the stored login only after the revocation succeeds or the server refuses the login.                                                                                                                                                           | section 9                 | both credentials present; two live grants of the CLI's client, the current one deleted first: `logout` revokes the one its token names, sends nothing after it, completes, and leaves the other listed; a failed revocation and a grant not listed yet (404) each keeping the entry; a stored login the server refuses removed; no command output carries a stored token                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## OAuth delivery

Pull requests in this order, the server first; each keeps `main` releasable, names the rows it makes pass, and moves
the threat model's status of the invariants it enforces. Clients are sent to sign in only from step 6, when the whole
flow works: before it, no `401` names the metadata.

1. **`feat(worker): bind OAuth KV, optional API tokens`**: the `OAUTH_KV` binding and `global_fetch_strictly_public` in
   `wrangler.jsonc`; `kv_namespaces` in the deployment values, with the deployment script's checks; 503 without the
   binding and 404 on OAuth paths in a `localhost` configuration; `API_TOKENS` optional. PL-46 to PL-48. The owner
   creates the namespace and adds its ID to the deployment values before merging the release PR that carries this
   step ([operations.md](operations.md), section 6).
2. **`feat(worker): serve the OAuth authorization server`**: `@cloudflare/workers-oauth-provider` 1.2.4 as
   `OAuthAuthorizationServer` on the three API-host paths behind the host classifier, with CIMD, DCR and the lifetimes
   of section 7, `Access-Control-*` removed, `OPTIONS` answered 405 on API routes, counted bodies, the `onError` hook,
   the KV wrapper that writes revocation records and the records' check before the token endpoint. PL-43 to PL-45.
3. **`feat(gallery): design the consent page`**: the screen and its components in `gallery.pen`, then `tokens.json`,
   `gallery.css`, `reference/consent.html` and the ground rule's exception (section 10).
4. **`feat(worker): add the OAuth consent page`**: `/oauth/authorize` on the app host with the library's helpers, the
   refusals of this deployment's hosts, the PKCE requirement, the publisher name, the CSP, the error pages, the
   replacement of a client's grants through `revokeGrant`, and `grant.created`. PL-35 to PL-39.
5. **`feat(worker): list and revoke OAuth grants`**: `/v1/grants`, so revocation exists before any client can use a
   token. PL-41 at the token endpoint; on `/mcp` and `/v1/` with step 6.
6. **`feat(worker): accept OAuth access tokens`**: the credential check of section 7 with the revocation record, the
   protected resource metadata, the challenge, the publisher name and grant ID in versions and logs, and the
   full-flow test. PL-7, PL-34, PL-40, PL-42.
7. **`feat(cli): sign in with OAuth`**: `oauth4webapi`, `login`, `logout`, the stored login and its lock, the
   credential precedence, the 401 hint and the refusal on Windows, with the end-to-end test against the Worker and
   the binaries' smoke tests. PL-49 to PL-51.
8. **`feat(cli): list and revoke grants`**: `grants` and `revoke <grant>`.

After the release that carries steps 1 to 6, the post-deployment checklist covers AC-14, AC-15 and AC-17 to AC-20; after
the CLI steps, AC-16.
