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

| ID  | Principle                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **One owner.** Every legitimate caller is the owner or an agent the owner gave a token. Defenses target a page an agent wrote that is buggy or prompt-injected, a leaked API token, and outsiders reaching the hosts. Nothing is built against untrusted users (quotas, rate limits, tenants). A safe default is taken when it is cheap; it is never a requirement. |
| P2  | **Each artifact is its own origin.** Artifact JavaScript reads its own files and storage and nothing else this host serves.                                                                                                                                                                                                                                         |
| P3  | **Browsers only read.** Every change goes through the API with a bearer token; no request authenticated by a cookie changes anything.                                                                                                                                                                                                                               |
| P4  | **A stored version never changes, and a publish is all or nothing.**                                                                                                                                                                                                                                                                                                |
| P5  | **One operation layer.** REST, MCP and the CLI are adapters over the same operations and operation error codes.                                                                                                                                                                                                                                                     |
| P6  | **The platform before own code, and the simpler option** when the risk the other guards against needs an untrusted user.                                                                                                                                                                                                                                            |
| P7  | **Deployment values stay out of the repository.**                                                                                                                                                                                                                                                                                                                   |

A restriction stays only with a reason tied to the purpose or to an implementation bound. A side effect a decision
accepts is stated where the decision is, with what is not lost.

## Overview

One Worker serves every host on Workers Paid. D1 holds metadata, R2 holds file bytes.

| Host                           | Example                     | Serves                                | Authenticated by                    |
| ------------------------------ | --------------------------- | ------------------------------------- | ----------------------------------- |
| `APP_HOST`                     | `artifacts.example.com`     | the gallery, read-only                | Access; the Worker verifies the JWT |
| `API_HOST`                     | `artifacts-api.example.com` | REST under `/v1/`, MCP at `/mcp`      | bearer API token                    |
| `<id>` + `CONTENT_HOST_SUFFIX` | `<id>-art.example.com`      | one artifact's files                  | Access; the Worker verifies the JWT |
| `<id>` + `PUBLIC_HOST_SUFFIX`  | `<id>-pub.example.com`      | one artifact's files, if it is public | none                                |

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
  applications keep the app and content audiences apart and work across zones.

### Cookies and what artifact JavaScript can reach

Artifact JavaScript can set a cookie for its host's parent domain, which every host under it then receives, and its
requests to hosts of the same registrable domain are same-site. In the shared-domain layout that reaches the owner's
other services; the threat model's accepted risk states the conditions under which this holds. This deployment's own
protections hold in both layouts: the gallery and the API read no cookie (ACC-1, TOK-1), nothing changes state on a
cookie (ISO-3), and nothing private can be read or loaded as a subresource across origins (ISO-2).

| Target                                   | Can                                                    | Cannot                                                            |
| ---------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| Its own files, all versions              | read                                                   | change them                                                       |
| Its own storage, cookies, service worker | everything; all versions share them                    | reach another artifact's                                          |
| Other artifact hosts, the gallery        | send requests (the owner's Access cookie may go along) | read a response or load it as a subresource (ISO-2); change state |
| The API                                  | send requests without a token                          | authenticate                                                      |
| Its host's `CF_Authorization` cookie     | —                                                      | read it (ACC-3)                                                   |

### Local development

Hosts such as `app.localhost:8787` and the suffix `-art.localhost:8787` come from `.dev.vars`. Access verification is
skipped only when every configured host is a `localhost` name, and the deployment script refuses `localhost` hosts
(ACC-2); no switch exists that could be copied into a deployment.

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
| Form          | relative, `/`-separated, no leading or trailing `/`, no empty segment: Cloudflare merges adjacent slashes in requests, and a trailing `/` names a directory index                                                                                                                                                                                                                  |
| Segments      | not `.` or `..`, which URL parsing and Cloudflare's normalization remove before a request arrives; the first segment is not `_v`, which pinned versions use, nor `cdn-cgi`, which Cloudflare manages on every proxied hostname and does not pass on ([`/cdn-cgi/`](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/)); both are refused before any write |
| Characters    | any Unicode scalar value except NUL, which SQLite's string functions treat as an end; `%`, `#`, `?` and `\` are allowed, and links percent-encode them (the authoring rule)                                                                                                                                                                                                        |
| Normalization | stored and looked up in NFC: macOS file names can arrive in NFD while pages name files in NFC                                                                                                                                                                                                                                                                                      |
| Case          | case-sensitive                                                                                                                                                                                                                                                                                                                                                                     |
| Length        | at most 1 KiB of UTF-8: the whole file list is loaded on every update and returned by `get`, so 2000 paths stay near 2 MiB                                                                                                                                                                                                                                                         |

A request is resolved from the pathname the Worker receives, after URL parsing and Cloudflare's normalization have
removed dot segments and merged slashes
([URL normalization](https://developers.cloudflare.com/rules/normalization/how-it-works/)): split on `/`, decode each
segment once with strict percent-decoding (a malformed escape or invalid UTF-8 answers 404; an encoded `/` answers
404), normalize to NFC, add `index.html` after a trailing `/`, and look the path up in the selected version only
(SRV-2). A directory with an `index.html` and no file of its own name answers 308 to the path with `/`, and so does
`/_v/<n>`; `<n>` is a canonical decimal of an existing version.

### Content types

The type given with a file, if any (`type/subtype` with parameters, at most 255 bytes); otherwise looked up from the
extension, with `; charset=utf-8` on text types and `application/octet-stream` for unknown extensions.

### Limits

| Bound                                | Value                      | Reason                                                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST publish request body            | 32 MiB                     | `formData()` holds the body in memory; an isolate has 128 MB and may serve several requests at once                                                                                                                                           |
| MCP request body                     | 4 MiB                      | the SDK's default; large binaries go through REST                                                                                                                                                                                             |
| REST `PATCH` body                    | 4 KiB, whitespace included | the largest valid body is under 100 bytes; the bound is counted on the raw body                                                                                                                                                               |
| Files per version and per request    | 2000                       | each new file costs up to four R2 calls (`head`, `put`, two retries) against 10,000 subrequests per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/)); equal bounds let any version be created in one request |
| Path, title, description             | 1 KiB, 1 KiB, 16 KiB       | above                                                                                                                                                                                                                                         |
| File content returned by `read_file` | 1 MiB                      | tool results go into the model's context                                                                                                                                                                                                      |
| Page size of a listing               | 1 to 100, default 50       | response size                                                                                                                                                                                                                                 |
| Wait for an R2 call, a D1 read       | 30 s, 10 s                 | RES-2; a `put` carries up to the REST request bound, and a D1 read is an indexed lookup or a page of at most 100 rows. The Access key set waits 5 s (ACC-1)                                                                                   |

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
  type is not revalidated. The REST file route sends the same tag.
- `Cache-Control: private, no-cache` on private hosts and `no-cache` on public hosts, for the latest and pinned versions
  alike. Access, the public flag and existence are checked before `If-None-Match` answers 304 (SRV-3), so revoking
  access, making an artifact private or deleting it takes effect on the next request. Immutability belongs to storage,
  not to the cache.
- `Cross-Origin-Resource-Policy: same-origin` on every response of a private content host and of the app host,
  including 304, 308 and 404, so another origin cannot load private content as a script, image, stylesheet or media
  with the owner's cookie (ISO-2). Public hosts omit it: their content needs no credential, and other sites may embed
  it.
- No `Content-Security-Policy` on artifacts: a page is the agent's code and may load from CDNs.
- `GET` and `HEAD` only (ISO-3); an unknown file answers a plain 404. `Range` is not supported in the first release,
  so audio and video cannot seek.

## 7. Auth

- **API tokens:** `art_` + 32 base32 characters (160 bits), generated by the CLI's `token` command (section 9), which
  prints the token once and its entry. The secret `API_TOKENS` maps a token name (`[a-z0-9-]{1,32}`, one per agent) to
  the hex SHA-256 of the token; a plain hash suffices for a random token, and about 40 entries fit in a 5 KB variable.
  It is a JSON object, `{"codex": "<64 lowercase hex>", …}`; two entries with the same hash are refused. The Worker
  compares the hash with every entry using `crypto.subtle.timingSafeEqual`
  ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)); the name becomes the version's
  `published_by` (TOK-1, TOK-3). Revoking is removing the entry and putting the secret again. OAuth is not used: every
  client in scope takes a static header.
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

| Code               | HTTP | When                                                                                  |
| ------------------ | ---- | ------------------------------------------------------------------------------------- |
| `invalid_request`  | 400  | input fails validation; `issues` lists `{ field, reason }`, reasons from a closed set |
| `not_found`        | 404  | no live artifact, version or file                                                     |
| `version_conflict` | 409  | `base_version` is not the latest; carries `latest_version`                            |
| `unavailable`      | 503  | invalid configuration, an unreachable key set, or a timed-out read or upload          |
| `internal`         | 500  | anything else; the message carries no detail                                          |

**Transport and protocol errors** come before or around an operation: 401 `unauthorized` with
`WWW-Authenticate: Bearer`, 403 for a foreign `Origin` on `/mcp` (HOST-3), 405, 413 for an oversized body and 415 for
the wrong body type, in the same JSON shape on REST and as plain HTTP answers on `/mcp`. On MCP, the SDK's own JSON-RPC
errors and its rejections of arguments that fail a tool's schema also belong here: they arrive as the SDK forms them,
so REST's `invalid_request` for the same input has no exact MCP twin.

### MCP server

- `@modelcontextprotocol/server` 2.4.0, `createMcpHandler` with its default stateless serving: one factory answers the
  2026-07-28 revision and the 2025-era revisions the SDK lists (2024-10-07 to 2025-11-25), which Claude Code, Codex CLI
  and Gemini CLI speak; `GET` and `DELETE` answer 405. The SDK checks neither hosts nor tokens, so the Worker checks
  the host, the token and the `Origin` first, removes the `Authorization` header, then builds the handler for the
  request with a factory whose closure holds the token name; the token never reaches the SDK (TOK-2). `McpAgent` from `agents` is not used: nothing needs
  sessions.
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
  `delete <id>`, `token <name>`; `--json` prints the API's JSON. `list` follows every page. Configuration:
  `ARTIFACTS_API_URL`, the API origin (`http` only for `localhost` names, since the token travels with it), and
  `ARTIFACTS_TOKEN`, which is never printed. The help text carries the authoring rule.
- **`publish` without `--id`** creates (`--title` required). After a lost response (no answer, or a 5xx) it lists
  every artifact and takes the one with the same title and description, version 1 and the same files (path and
  SHA-256), creating once more only when none matches. **With `--id`** it reads the latest version, hashes local files
  with `node:crypto` `createHash` as streams, sends new and changed files, removes paths the directory lacks, and sends
  the version it read as `base_version`; a conflict is reported, not retried. In place of a directory, `publish` takes
  one `.html` or `.htm` file as the version's only file, `index.html`; any other single file is refused.
- **`pull`** writes every file of a version into a new or empty directory, so that `publish --id` from it reproduces
  the version. Each file is created exclusively and checked against its listed size and SHA-256.
- **`token <name>`** generates an API token (section 7) and prints it once with its `API_TOKENS` entry.
- **Directory mapping:** every regular file below the directory, by relative POSIX path in NFC. Names starting with `.`
  are skipped, so `.env` and `.git/` are never published by accident. A symbolic link is followed when its target
  resolves inside the directory, and its files are published under the link's path as well as the target's, since
  pages may reference either; a link that leaves the directory, or points to a directory on the path from the root to
  itself (a loop), is refused. The root
  `index.html`, the file count and the request bound are checked before sending; a publish over the bound is refused,
  not split into versions.
- **Distribution:** TypeScript without runtime dependencies, run by Node 24 from a checkout and put on `PATH` by a
  symbolic link; Node strips types outside `node_modules`, so there is no build and no npm package.

## 10. Gallery

Server-rendered on `APP_HOST`, without script, forms or frames; the screens follow
[gallery/design.md](gallery/design.md).

| Page        | Shows                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`         | Artifacts that are not archived, in the API's order, 50 per page with a link to the next: title, start of the description, update time, latest version, public, links                                |
| `/archived` | The same for archived artifacts, with why each is archived (setting or age)                                                                                                                          |
| `/a/<id>`   | Title, description, URLs, public and archive state; the version history, newest first and 50 per page, with time, `published_by`, title, file count, size and pinned URL; the latest version's files |

A deleted artifact and any other path answer 404. Artifact text is escaped and the CSP forbids scripts and framing
(ISO-5). The gallery links to artifacts rather than framing them: Access's behavior in frames is not documented.

## 11. Operations

- **Configuration split:** `packages/worker/wrangler.jsonc` (public) holds bindings (`DB`, `FILES`), migrations and
  observability with invocation logs off. The gitignored `wrangler.deploy.jsonc` holds the account, routes, custom
  domains, database and bucket identifiers, and the variables `APP_HOST`, `API_HOST`, `CONTENT_HOST_SUFFIX`,
  `PUBLIC_HOST_SUFFIX`, `ARCHIVE_AFTER_DAYS`, `ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD` and `ACCESS_CONTENT_AUD`;
  `API_TOKENS` is a secret. A deployment script checks the file with the Worker's own parser, merges, and runs
  `wrangler deploy` (DATA-2).
- **Cloudflare setup by the owner:** the proxied wildcard DNS record, the two Access applications, the D1 database and a
  private R2 bucket, on Workers Paid.
- **Logging:** `logEvent` only, with closed fields; every change logs its token name, so the 7 days of Workers Logs
  show what a leaked token did (DATA-1).
- **No backup of bytes.** Artifacts are agent output that can be produced again; deletion with a leaked token is
  answered by revoking the token. D1 Time Travel restores metadata for 30 days
  ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)), which covers damaged rows only. Old
  artifacts are archived (section 5), not moved.

## Not in the first release

Version pruning (section 4), `Range` (section 6), splitting a large CLI publish (section 9), gallery previews and
search (section 10), backups of bytes (section 11).

## Purpose layer: acceptance criteria

Sources are the agreed scope: **Interfaces** (MCP and REST from one implementation, a thin CLI), **Auth** (Access for
browsers, bearer tokens for agents, public links), **Domain** (a host per artifact), **Features** (publish, read, list,
delete; version history; multiple files; gallery; archive). Each is checked on the deployed Worker with real clients
and a browser; copies a browser already downloaded are out of scope.

| ID    | Requirement (EARS)                                                                                                                                                                   | Source                        | Scenario; pass and failure                                                                                                                                                                 | Checked on                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| AC-1  | When an agent calls `create_artifact` over MCP with a title and an `index.html`, the system shall return a URL that shows that page.                                                 | Interfaces; Features          | Claude Code, Codex CLI and Gemini CLI, each with `/mcp` and its own token, publish a page. Pass: the URL renders after Access sign-in. Fail: no connection, a tool error, no page          | each client; a browser       |
| AC-2  | When the CLI publishes a directory, the system shall serve every file it sends, and the CLI shall skip names starting with `.` and refuse links that leave the directory.            | Interfaces; Features (files)  | `index.html`, a stylesheet, a script, a PNG, a `.env`, a link inside and one outside. Pass: the page renders with its assets and types; `.env` absent; the outside link refused            | the CLI; a browser           |
| AC-3  | When an agent updates an artifact whose pages follow the authoring rule, the system shall serve the new version at its URL and every earlier version at its pinned URL.              | Features (version history)    | Two updates through MCP. Pass: `/` shows version 3, `/_v/1/` and `/_v/2/` theirs, each with its own files. Fail: a version changed or missing                                              | a real MCP client; a browser |
| AC-4  | When an agent lists, reads or deletes artifacts over MCP, the system shall answer with their stored state, and after a delete every URL shall answer 404.                            | Features (list, read, delete) | List, `get_artifact`, `read_file`, `delete_artifact`, then reload the old URLs. Fail: stale content or a URL that still serves                                                             | a real MCP client; a browser |
| AC-5  | When the owner browses the gallery, the system shall list every artifact and version across pages, and offer nothing that changes state.                                             | Features (gallery)            | More than 50 artifacts and an artifact with more than 50 versions. Pass: every one reachable through the page links; no forms or scripts                                                   | a browser                    |
| AC-6  | While a browser is not signed in to Access as the owner, the system shall serve neither the gallery nor a private artifact.                                                          | Auth (Access)                 | A private window; another identity. Pass: sign-in, then denial. Fail: any artifact byte or gallery entry                                                                                   | a browser                    |
| AC-7  | If a request to the REST API or `/mcp` carries no valid token, then the system shall answer 401 and change nothing.                                                                  | Auth (tokens)                 | `curl` without a token, with a wrong and with a revoked one, on each route                                                                                                                 | `curl`                       |
| AC-8  | While an artifact page runs in the owner's browser, the system shall not let its script read, or load as a subresource, another artifact, the gallery, the API or its Access cookie. | Domain                        | A probe artifact A fetches artifact B, the gallery and the API, loads B's script with `<script src>`, reads `document.cookie` and B's storage. Pass: all fail while B loads its own script | a browser                    |
| AC-9  | When the owner makes an artifact public, the system shall serve all its versions at its public URL without sign-in, and when made private, the next request shall answer 404.        | Auth (public links)           | `public on`, open the latest and a pinned URL in a private window, `public off`, reload                                                                                                    | the CLI; a private window    |
| AC-10 | If two agents update one artifact from the same version, then the system shall commit one update and answer the other with a conflict.                                               | Features (version history)    | Two CLI publishes held at a barrier after both read the same latest version, then released. Pass: one new version, one `version_conflict`, no mixed files                                  | two CLI processes            |
| AC-11 | When a client initializes `/mcp`, the system shall return the instructions of section 8.                                                                                             | Interfaces (MCP)              | Read the returned instructions. Smoke check: an agent given only the server publishes a multi-file page and updates it, and both URLs render with their own files                          | a real MCP client            |
| AC-12 | When a script uses the REST API to create, update, read and delete an artifact, the system shall give the results the MCP tools give.                                                | Interfaces (REST)             | `curl` with multipart create and update, `GET` of a file's bytes, `DELETE` twice (204 both times)                                                                                          | `curl`; a browser            |
| AC-13 | When the owner archives an artifact, the system shall move it from the gallery's default list to the archived view and keep every URL serving.                                       | Features (archive)            | `archive <id> on`, then `auto`; browse `/`, `/archived` and the artifact URLs. Fail: a URL changes or the artifact is in the wrong list                                                    | the CLI; a browser           |

## Plan layer

Claims derived from the purpose layer, each checked without the deployed Worker (unit tests, or the Worker in the
local runtime with D1 and R2). A row naming a threat-model ID claims that invariant; the invariant's text is there.

| ID    | Claim (EARS)                                                                                                                                                                                                                         | Source           | Test                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PL-1  | The Worker shall classify hosts as HOST-1 states.                                                                                                                                                                                    | HOST-1           | hosts with an extra label, uppercase, 25- and 27-character prefixes, a port, a hyphen                                                                                                                                                                                                                                                                   |
| PL-2  | If a configuration value weakens a boundary, then the Worker and the deployment script shall refuse it.                                                                                                                              | HOST-2, ACC-2    | one case per refusal, for both                                                                                                                                                                                                                                                                                                                          |
| PL-3  | When an app or private content request arrives, the Worker shall apply ACC-1.                                                                                                                                                        | ACC-1, ISO-4     | missing JWT, bad signature, other issuer, other class's audience, missing `exp`, expiry at the tolerance edges, `alg` other than RS256, unknown `kid` refreshing once, key endpoint down (503), JWT only as a cookie                                                                                                                                    |
| PL-4  | While the configured hosts are not all `localhost` names, the Worker shall verify Access.                                                                                                                                            | ACC-2            | production-shaped hosts without a JWT                                                                                                                                                                                                                                                                                                                   |
| PL-5  | When an API request arrives, the Worker shall apply TOK-1 on every REST route and `/mcp`.                                                                                                                                            | TOK-1            | no header, another scheme, unknown and removed tokens; nothing changed                                                                                                                                                                                                                                                                                  |
| PL-6  | If `/mcp` receives an `Origin` other than the API host's origin, then the Worker shall answer 403.                                                                                                                                   | HOST-3           | foreign, `null` and matching origins; no `Origin`                                                                                                                                                                                                                                                                                                       |
| PL-7  | When a version is committed or an artifact changed, the system shall record or log the token name.                                                                                                                                   | TOK-3            | publishes with two tokens; change logs                                                                                                                                                                                                                                                                                                                  |
| PL-8  | The Worker shall keep DATA-1 on every route and failure path.                                                                                                                                                                        | DATA-1, TOK-2    | log redaction with markers; source check of the `console` sink; at the MCP handler boundary, the request and factory context carry no `Authorization` header or token                                                                                                                                                                                   |
| PL-9  | When a content host is requested, the Worker shall serve only its artifact's files.                                                                                                                                                  | ISO-1            | two artifacts with the same path and different bytes; a deleted ID offered again by a stubbed generator                                                                                                                                                                                                                                                 |
| PL-10 | The Worker shall send no `Access-Control-Allow-*` header, and `Cross-Origin-Resource-Policy: same-origin` on every private content and app response.                                                                                 | ISO-2            | every route and status (200, 304, 308, 404); public host responses without it                                                                                                                                                                                                                                                                           |
| PL-11 | If a request to the app host or a content host uses a method other than GET or HEAD, then the Worker shall answer 405; it shall set no cookie.                                                                                       | ISO-3, ISO-4     | each method on each host class                                                                                                                                                                                                                                                                                                                          |
| PL-12 | When the gallery renders artifact text, the Worker shall apply ISO-5.                                                                                                                                                                | ISO-5            | markup and attribute breakouts in titles, descriptions and paths                                                                                                                                                                                                                                                                                        |
| PL-13 | When a file is served, the Worker shall send the headers of section 6.                                                                                                                                                               | SRV-1, section 6 | per host class, latest and pinned                                                                                                                                                                                                                                                                                                                       |
| PL-14 | If an artifact became private, was deleted or the request lacks access, then a matching `If-None-Match` shall not yield 304.                                                                                                         | SRV-3            | the three cases, latest and pinned                                                                                                                                                                                                                                                                                                                      |
| PL-15 | When a segment is decoded, the decoder shall accept exactly one strict percent-decoding and refuse an encoded `/`.                                                                                                                   | SRV-2            | over strings: malformed escapes, invalid UTF-8, `%2F`, `%25`, `%23`, `%3F`, NFD to NFC                                                                                                                                                                                                                                                                  |
| PL-16 | When a `Request` reaches a content host, the Worker shall select the version and file of SRV-2 and section 6.                                                                                                                        | SRV-2            | real `Request` objects: latest and pinned paths, names with `%`, `#` and `?`, a directory (308), `/_v/<n>` (308), `_v/0`, `_v/01` and one past the latest (404); never a fallback to the latest; dot segments (`/_v/2/../index.html`) and doubled slashes, asserting the version and path served                                                        |
| PL-17 | When the public host serves an artifact, the Worker shall apply PUB-1.                                                                                                                                                               | PUB-1, PUB-2     | identical 404s; pinned versions while public; 404 on the request after `public off`                                                                                                                                                                                                                                                                     |
| PL-18 | If a publish fails before its commit or its batch rolls back, then no version shall be visible; if its response is lost after the commit, the version and its objects shall remain.                                                  | VER-2            | a failure at each upload, an upload timeout, a failing batch; a create and an update whose commit succeeds and whose response is dropped: the objects remain, a listing finds the create, and a retried update answers `version_conflict`                                                                                                               |
| PL-19 | If `base_version` is not the latest or the artifact was deleted meanwhile, then an update shall commit nothing.                                                                                                                      | VER-3            | stale base; two concurrent updates from one base; a delete between upload and commit                                                                                                                                                                                                                                                                    |
| PL-20 | When files are stored, their keys and earlier versions shall satisfy VER-1 and VER-4.                                                                                                                                                | VER-1, VER-4     | R2 and D1 contents after publishes that share and change files                                                                                                                                                                                                                                                                                          |
| PL-21 | When a publish provides the same bytes twice or bytes already stored, the system shall write each object at most once, retrying R2's 429 at most twice.                                                                              | section 3        | two paths with equal bytes; an existing object; a stubbed 429 once and three times                                                                                                                                                                                                                                                                      |
| PL-22 | When an artifact is deleted, every URL shall answer 404 at once; when the cleanup succeeds, its prefix shall hold no object that landed before the cleanup; a repeated delete shall remove objects that landed later and answer 204. | VER-4            | URLs after delete; the prefix after cleanup; an injected cleanup failure, then a second `DELETE`; an upload started before the delete that lands after the cleanup, removed by a second `DELETE`                                                                                                                                                        |
| PL-23 | When an update omits, removes or provides paths, the new version shall hold section 4's merge, and a version without `index.html` shall be refused with its message.                                                                 | section 4        | table of update cases, through REST and MCP                                                                                                                                                                                                                                                                                                             |
| PL-24 | If an input exceeds a bound of section 6, then the system shall refuse it before any write.                                                                                                                                          | RES-1            | at and one past each bound in its unit; a chunked body without `Content-Length`                                                                                                                                                                                                                                                                         |
| PL-25 | If the key fetch, an R2 call or a D1 read exceeds its timeout, then the request shall answer 503, and a publish shall not have committed.                                                                                            | RES-2            | stubbed slow key endpoint, R2 and D1 reads; the commit has no timeout                                                                                                                                                                                                                                                                                   |
| PL-26 | When an input passes both adapters' schemas, REST and MCP shall return the same result or operation error code, except for `read_file`'s directory paths and files over 1 MiB (section 8).                                           | P5, section 8    | one table of cases through both adapters, a directory path pinning the `read_file` difference; the file over 1 MiB checked on its own; schema rejections checked separately per adapter                                                                                                                                                                 |
| PL-27 | When a client speaking 2025-03-26, 2025-06-18, 2025-11-25 or 2026-07-28 lists and calls tools, `/mcp` shall serve it, and `GET` shall answer 405.                                                                                    | section 8        | the SDK's client against the local Worker, per revision                                                                                                                                                                                                                                                                                                 |
| PL-28 | When a listing is paged, the system shall follow section 8's order and cursor contract.                                                                                                                                              | section 8        | order ties on `updated_at`; `next_cursor: null` at the end; a malformed cursor; an artifact updated mid-traversal is not repeated                                                                                                                                                                                                                       |
| PL-29 | When an artifact's archive setting or age changes, the system shall report and filter it as section 5 states, and change no version or URL.                                                                                          | section 5        | `archived`, `kept` and unset with an injected clock either side of `ARCHIVE_AFTER_DAYS`; each `archived=` filter; URLs and versions unchanged; an archive change during an in-flight update; an update whose clock is behind the stored `updated_at`; the filter applied before pagination                                                              |
| PL-30 | When the CLI maps a directory, it shall follow section 9.                                                                                                                                                                            | section 9        | dot names, a directory, an alias link to it and pages referencing both paths, a link outside, a link to an ancestor (refused), NFD names, an unchanged file not sent, `base_version` equal to the version read; a file named with `\`, `#` and `?` sent by the CLI and served at its percent-encoded path; multi-page `list`, with and without `--json` |
| PL-31 | The repository's `wrangler.jsonc` shall set no variable, route or account identifier.                                                                                                                                                | DATA-2           | source check of the file and the deployment example                                                                                                                                                                                                                                                                                                     |
| PL-32 | If a path's first segment is `_v` or `cdn-cgi`, then a publish shall be refused before any write.                                                                                                                                    | section 6        | create and update through REST and MCP; D1 and R2 unchanged                                                                                                                                                                                                                                                                                             |
