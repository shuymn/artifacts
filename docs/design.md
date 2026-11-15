# Design

What `artifacts` is for, the principles every decision is measured against, the decisions, and the acceptance criteria
that say when the first release is done. Security invariants are in [threat-model.md](threat-model.md) (IDs such as
`ISO-2`); libraries and code patterns are in [decisions.md](decisions.md).

## Purpose

AI agents (Claude, Codex, Gemini CLI, scripts) publish HTML pages with their CSS, JavaScript and images to a host the
owner runs on Cloudflare. The owner opens each page in a browser at its own origin. Every update is a new version, and
earlier versions stay viewable. A gallery lists everything. An artifact can be shared through a public link.

One person deploys and uses a deployment. It is not a multi-tenant or open service.

## Principles

| ID  | Principle                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **One owner.** Every legitimate caller is the owner or an agent the owner gave a token. Defenses target three things: a page an agent wrote that is buggy or prompt-injected, a leaked API token, and outsiders reaching the hosts. Nothing is built against untrusted users (quotas, rate limits, tenant separation). A safe default is taken when it is cheap; it is never a requirement. |
| P2  | **Each artifact is its own origin.** Artifact JavaScript reads its own files and storage and nothing else this host serves.                                                                                                                                                                                                                                                                 |
| P3  | **Browsers only read.** Every change goes through the API with a bearer token. No request authenticated by a cookie changes anything.                                                                                                                                                                                                                                                       |
| P4  | **A version never changes, and a publish is all or nothing.**                                                                                                                                                                                                                                                                                                                               |
| P5  | **One operation layer.** REST, MCP and the CLI are adapters over the same operations, input schemas and error codes.                                                                                                                                                                                                                                                                        |
| P6  | **The platform before own code, and the simpler option** when the risk the other guards against needs an untrusted user.                                                                                                                                                                                                                                                                    |
| P7  | **Deployment values stay out of the repository.** Hosts, account, database and bucket identifiers live in a gitignored file.                                                                                                                                                                                                                                                                |

A side effect the design accepts states what is not lost and why; one that cannot is not accepted
([Accepted side effects](#accepted-side-effects)).

## Overview

One Worker serves every host. D1 holds metadata, R2 holds file bytes.

| Host                                     | Example                      | Serves                                | Authenticated by                    |
| ---------------------------------------- | ---------------------------- | ------------------------------------- | ----------------------------------- |
| `APP_HOST`                               | `artifacts.example.com`      | the gallery, read-only                | Access; the Worker verifies the JWT |
| `API_HOST`                               | `artifacts-api.example.com`  | REST under `/v1/`, MCP at `/mcp`      | bearer API token                    |
| `<id>` + `CONTENT_HOST_SUFFIX`           | `<id>-p.example-content.net` | one artifact's files                  | Access; the Worker verifies the JWT |
| `<id>` + `PUBLIC_HOST_SUFFIX` (optional) | `<id>-s.example-content.net` | one artifact's files, if it is public | none                                |

## 1. Hosts and origins

**Hosts are deployment values.** `APP_HOST`, `API_HOST`, `CONTENT_HOST_SUFFIX` and the optional `PUBLIC_HOST_SUFFIX`.
An artifact's host is its ID followed by a suffix. IDs have a fixed length of 26 characters (section 2), so the Worker
classifies a host by exact comparison: it is `APP_HOST`, `API_HOST`, or its first 26 characters are a valid ID and the
rest equals one of the suffixes. Any other host answers 404 without touching storage (HOST-1).

A suffix has one of two forms, and both keep the artifact host a first-level subdomain:

- `.domain`: `<id>.example-content.net`;
- `-label.domain`: `<id>-p.example-content.net`, or `<id>-art.example.com` on a domain that also hosts other services.

The configuration check (HOST-2) refuses a public suffix that ends with the content suffix (the content Access
wildcard would then cover public hosts), an app or API host that ends with either suffix, and a label part longer than
37 characters (26 + 37 = 63, the DNS label limit).

### Layouts

| Setting               | Recommended: content on its own registrable domain               | One domain the owner already uses                          |
| --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| `APP_HOST`            | `artifacts.example.com` (Workers Custom Domain)                  | `artifacts.example.com` (Workers Custom Domain)            |
| `API_HOST`            | `artifacts-api.example.com` (Workers Custom Domain)              | `artifacts-api.example.com` (Workers Custom Domain)        |
| `CONTENT_HOST_SUFFIX` | `-p.example-content.net`                                         | `-art.example.com`                                         |
| `PUBLIC_HOST_SUFFIX`  | `-s.example-content.net`                                         | `-pub.example.com`                                         |
| Workers Routes        | `*.example-content.net/*`                                        | `*-art.example.com/*`, `*-pub.example.com/*`               |
| DNS                   | proxied wildcard record `*.example-content.net`                  | proxied wildcard record `*.example.com`                    |
| Access applications   | app: `artifacts.example.com`; content: `*-p.example-content.net` | app: `artifacts.example.com`; content: `*-art.example.com` |

The `-p` label on the dedicated domain lets public hosts be added later without changing any private origin; an owner
who never wants public links can use `.example-content.net`. Changing a suffix later moves every artifact to a new
origin (its storage stays behind), so the suffixes are chosen once.

Reasons:

- **Certificates.** Universal SSL covers the apex and first-level subdomains only; `<id>.art.example.com` would need
  Advanced Certificate Manager or a certificate per host
  ([Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)).
  Both suffix forms stay first-level.
- **Routes, not Custom Domains, for content.** Custom Domains do not take wildcards
  ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)); one per artifact
  would put a Cloudflare API credential in the Worker and wait for a certificate on every create. A Route takes a
  leading wildcard, including a partial label (`*-art.example.com/*`), and needs a proxied DNS record
  ([Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)).
- **Not capturing other services.** On a shared domain, `*.example.com/*` would capture every proxied host of the
  owner's other services that has no more specific route. Negation routes (a route without a Worker per other host)
  would have to follow every service the owner adds. A label suffix matches only names that end in it, so it captures
  nothing as long as no other host uses that ending.
- **Access.** A self-hosted Access application accepts a wildcard with a partial label and several hostnames, with one
  AUD tag per application ([application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)).
  Two applications, app and content, keep the audiences apart and allow the hosts to sit in different zones.

### Cookies and same-site requests

Artifact JavaScript can set a cookie for the parent domain of its host, and browsers send it to every host under that
domain; requests between hosts of one registrable domain are same-site, so `SameSite` does not separate them.

- **Content on its own registrable domain (recommended).** The parent domain holds only artifact hosts. A page can at
  worst disturb another artifact host's Access cookie, which costs a sign-in redirect until the cookie is cleared. The
  app and API hosts are another site.
- **One shared domain.** Everything this host protects still holds: the gallery and the API never read a cookie
  (ACC-1, TOK-1), nothing changes state on a cookie (ISO-3), and no response allows a cross-origin read (ISO-2). What is
  given up concerns the owner's other services on that domain: a page can toss cookies into them, its requests to them
  are same-site, and a page published with a leaked token sits on the owner's main domain (its reputation, Safe
  Browsing). A page can also break Access sign-in on the app host until cookies are cleared. The threat model lists
  these as an accepted risk with the condition under which it holds.

### What artifact JavaScript can reach

| Target                                   | Can                                                        | Cannot                                         |
| ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Its own files, all versions              | read (same origin)                                         | change them                                    |
| Its own storage, cookies, service worker | everything; versions share them                            | reach another artifact's                       |
| Other artifact hosts, the gallery        | send GET requests (the owner's Access cookie may go along) | read a response (no CORS, ISO-2); change state |
| The API                                  | send requests without a token                              | authenticate (tokens never reach a browser)    |
| Its host's `CF_Authorization` cookie     | —                                                          | read it (HttpOnly, ACC-3)                      |
| The internet                             | anything a web page can do                                 | —                                              |

The gallery stays read-only for this reason: with no cookie-authenticated write anywhere, a page has nothing to forge.

### Local development

Hosts such as `app.localhost:8787`, `api.localhost:8787` and the suffix `-p.localhost:8787` come from `.dev.vars`
(gitignored; an example file is committed). Access verification is skipped only when every configured host is a
`localhost` name; the configuration check refuses a mix of `localhost` and other hosts, and the deployment script
refuses `localhost` hosts and ports (ACC-2). There is no switch that turns Access off and could be copied into a
deployment. Chrome and Firefox resolve `*.localhost` to the loopback address.

## 2. Artifact identity

- **ID:** 26 characters from `a-z2-7` (the RFC 4648 base32 alphabet, lowercase), each from 5 bits of a byte from
  `crypto.getRandomValues`: 130 bits. It is a valid DNS label (no dot or hyphen) and long enough that a public link
  cannot be guessed. An ID is never reused: deleting an artifact keeps its row as a tombstone, and the primary key
  refuses an ID that ever existed (ISO-1). A reused ID would inherit the old origin's storage, cookies and service
  worker in the owner's browser.
- **Rejected:** UUIDs (36 characters for 122 bits), ULIDs (the time prefix lowers the unguessable part), short IDs (a
  public link must not be guessable).
- **Title:** required when creating, 1 to 200 code points, no control characters. **Description:** 0 to 2000 code
  points, no control characters except line feed. Both belong to a version; the artifact shows its latest version's. An
  update that omits them keeps the base version's.

## 3. Data model and storage

**D1 for metadata, R2 for bytes.**

| Table           | Columns                                                                                                    | Keys                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `artifacts`     | `id`, `created_at`, `updated_at`, `latest_version`, `public`, `deleted_at`                                 | primary `id`                                               |
| `versions`      | `artifact_id`, `number`, `created_at`, `published_by`, `title`, `description`, `file_count`, `total_bytes` | primary (`artifact_id`, `number`); foreign `artifact_id`   |
| `version_files` | `artifact_id`, `number`, `path`, `sha256`, `size`, `content_type`                                          | primary (`artifact_id`, `number`, `path`); foreign version |

A file's bytes are the R2 object `a/<id>/<sha256 hex>`. Equal bytes are stored once across the versions of one
artifact; no object is shared between artifacts, so deleting an artifact deletes its prefix without checking
references (VER-4).

| Concern       | D1 + R2                                                                                                                                        | One SQLite Durable Object (+ R2)                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Atomic commit | `batch()` is one transaction; a failing statement rolls back the sequence ([D1](https://developers.cloudflare.com/d1/worker-api/d1-database/)) | `transactionSync`                                      |
| Concurrency   | primary keys and conditioned statements detect a conflict                                                                                      | the object serializes requests                         |
| Code          | the Worker uses the binding directly                                                                                                           | an RPC class and migrations inside the object          |
| Recovery      | Time Travel, 30 days on Workers Paid ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/))                              | point-in-time recovery                                 |
| Fit           | request and response only                                                                                                                      | its strengths (WebSockets, hibernation, alarms) unused |

D1 is chosen: the one thing the object would add, serialization, is replaced by the keys, and nothing here needs a
long-lived object. Foreign keys are enforced by default
([foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)).

### Publish sequence

1. Authenticate, then validate the whole input (bounds, paths, the merged file list, the entry file) before any write.
2. On an update, read the base version's file list.
3. For each provided file, compute the SHA-256 of its bytes. If the base version already has that hash, skip the
   upload; otherwise `put` it at `a/<id>/<sha256>`, passing the hash as R2's integrity check. Uploads run a few at a
   time, each with a timeout (RES-2).
4. Commit in one D1 batch: the artifact row (inserted on create; on update, `latest_version` advanced from
   `base_version` only while the artifact is live), the version row, and every `version_files` row, provided and kept.
   Each statement after the first is conditioned on the artifact row having been advanced, and the primary and foreign
   keys back the conditions. A conflict shows as no advanced row or a key violation, and the whole batch rolls back.
5. Answer with the artifact and the new version.

| Event                                          | What it leaves                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation fails                               | nothing                                                                                                                                                                                                                                                                     |
| An upload fails or times out; the commit fails | no version; uploaded objects under the artifact's prefix that nothing references. On create the Worker deletes them, best effort: the ID is new, so no other request uses them. On update it deletes nothing, because a concurrent publish may have committed the same hash |
| Two updates from the same base                 | one version; the other request answers `version_conflict` with `latest_version`                                                                                                                                                                                             |
| Delete while an update is in flight            | the delete commits the tombstone and removes the rows, then deletes the prefix; the update's commit finds no live artifact and answers `not_found`; objects it uploaded after the prefix was deleted stay                                                                   |
| The delete's prefix deletion stops part-way    | no rows; the remaining objects stay                                                                                                                                                                                                                                         |

Unreferenced objects are never served: serving goes through `version_files`. They are an accepted side effect.

## 4. Versioning and updates

- Every publish creates version `n + 1`; creating an artifact creates version 1. A committed version never changes
  (VER-1). The latest version is the highest number.
- **Update input:** `base_version` (required), `files` (each replaces or adds a path), `remove` (paths), and optionally
  `title` and `description`. Every base file that is neither provided nor removed is kept. A path both provided and
  removed, or a removed path the base does not have, is refused: both are agent mistakes worth reporting.
- **Departure from a `null` per path:** removals are a `remove` list. A multipart REST request cannot carry `null` for
  a file part, and one shape then serves both adapters; the semantics are the same.
- **Optimistic concurrency:** an update whose `base_version` is not the latest answers 409 `version_conflict` with
  `latest_version`, and commits nothing (VER-3). The agent reads the latest and retries on top of it.
- **Addressing:** the latest version at `/`, version `n` at `/_v/<n>/`. All versions share the artifact's origin, so
  the page's own state survives updates. Pages must link between their files with relative URLs (`style.css`,
  `img/a.png`); a root-relative URL (`/style.css`) loads the latest version's file from a pinned page. The MCP
  instructions state this rule.
- **Rejected: a host per version.** It would split storage per version (state lost on every update), add an Access
  redirect for every new host, and lengthen labels; what it buys is that root-relative URLs work in old versions.
- **Entry file:** `index.html` at the root, required in every version. A request for `dir/` serves `dir/index.html`.
- **Pruning** is not in the first release. Objects are shared between versions of an artifact, so removing one safely
  needs reference checks that race with publishes; deleting the whole artifact removes everything.

## 5. Files and serving

### Paths

| Rule          | Value                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Form          | relative, segments separated by `/`; no leading or trailing `/`, no empty segment                    |
| Segments      | not `.` or `..`, not starting with `.`; the first segment is not `_v` (reserved for pinned versions) |
| Characters    | Unicode scalar values except C0 and C1 controls, `\`, `?`, `#` and `%`                               |
| Normalization | stored in NFC; input is normalized, then checked for duplicates                                      |
| Case          | case-sensitive                                                                                       |
| Length        | path at most 512 UTF-8 bytes; segment at most 255 UTF-8 bytes                                        |
| Count         | at most 1000 files per version                                                                       |

`?` and `#` would make a file unreachable by a relative link; `%` would need a second decoding step to name. Segments
starting with `.` keep files such as `.env` or `.git/` out by accident and keep `/.well-known/` free.

A request path is resolved by splitting the raw path on `/`, percent-decoding each segment strictly (malformed escapes,
invalid UTF-8 or a decoded character the rules forbid answer 404, so `%2F` never becomes a separator), normalizing to
NFC, and adding `index.html` after a trailing `/` (SRV-2). A path that names a directory with an `index.html` but no
file of its own answers 308 to the same path with a trailing `/`, so that relative links resolve inside it. `/_v/<n>`
redirects to `/_v/<n>/` the same way; `<n>` is a canonical decimal (no leading zero) of an existing version.

### Content types

A file's type is the one given with it, if any: it must parse as `type/subtype` with optional parameters, at most 255
bytes. Otherwise it is looked up from the extension; text types (`text/*`, JSON, JavaScript, SVG, XML) get
`; charset=utf-8`, and an unknown extension is `application/octet-stream`. A wrong type breaks the page, nothing else:
every response has `nosniff`, and the page is alone on its origin.

### Limits

These bounds catch agent mistakes and keep requests within the platform's limits; they are not quotas (P1).

| Bound                                | Value                      | Reason                                                                                      |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- |
| File size                            | 25 MiB                     | images, fonts and scripts fit; larger media is not an HTML artifact's asset in this release |
| Files per version                    | 1000                       | `version_files` rows written in one commit; one gallery page lists them                     |
| REST publish request body            | 32 MiB                     | the multipart body is held in memory while it is read (128 MB per isolate)                  |
| MCP request body                     | 4 MiB                      | the SDK's default; base64 makes binary content 4/3 as large                                 |
| File content returned by `read_file` | 1 MiB                      | tool results go into the model's context                                                    |
| Title / description                  | 200 / 2000 code points     | section 2                                                                                   |
| Page size of a listing               | 1 to 100 items, default 50 |                                                                                             |

The request body is counted as it is read, so a body without `Content-Length` stops at the bound (RES-1). There is no
per-artifact or total quota and no limit on the number of versions. Hashing a full REST request exceeds the Free plan's
10 ms of CPU, so the Worker runs on Workers Paid ([limits](https://developers.cloudflare.com/workers/platform/limits/)).

### How bytes travel

- **MCP:** JSON tool arguments. Each file is `{ path, content, encoding, content_type? }`, with `encoding` `"utf8"`
  (the default; the string must be well-formed Unicode) or `"base64"` (RFC 4648 with padding, no whitespace).
- **REST:** `multipart/form-data`. A `meta` part holds the JSON input without file contents; `meta.files[n]` gives the
  path and optional type of the n-th part named `file`, whose bytes are taken as they are. Part file names and part
  types are ignored, so no path or type depends on how a client encodes a part header.
- Both adapters produce the same operation input; the operation does not know which one called it (P5).

### Serving

| Header or behavior     | Latest version (`/…`)                                                              | Pinned version (`/_v/<n>/…`)                                      |
| ---------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `Content-Type`         | the stored type                                                                    | the stored type                                                   |
| `ETag`                 | `"<sha256>"` of the file                                                           | `"<sha256>"` of the file                                          |
| `Cache-Control`        | `private, no-cache` (public host: `no-cache`)                                      | `private, max-age=31536000, immutable` (public host: `public, …`) |
| Conditional request    | `If-None-Match` answers 304                                                        | `If-None-Match` answers 304                                       |
| Every content response | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, no CORS headers |                                                                   |

- `no-referrer` keeps a public artifact's host, which is its share link, out of the `Referer` of links and assets; a
  page can still set its own policy.
- No `Content-Security-Policy` and no `frame-ancestors` on artifacts: a page is the agent's code, may load from CDNs,
  and has no action on this host to protect from framing.
- `GET` and `HEAD` only; other methods answer 405 (ISO-3). An unknown file answers a plain 404. `Range` requests are
  not supported in the first release, so seeking in audio or video does not work.

## 6. Auth

### API tokens

- A token is `art_` followed by 32 base32 characters (160 bits), generated by a repository script that prints the
  token once and the entry to add to the secret.
- The Worker secret `API_TOKENS` is a JSON object from a token name (`[a-z0-9-]{1,32}`, one per agent) to the
  lowercase hex SHA-256 of the token. A plain hash is enough because the token is random; the secret never holds a
  token. About 40 entries fit in the 5 KB a variable may hold
  ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
- A request's token is hashed and compared with every entry using `crypto.subtle.timingSafeEqual`
  ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)); a match yields the token name,
  which each version records as `published_by` (TOK-1, TOK-3).
- Revoking a token is removing its entry and putting the secret again.
- **Rejected:** tokens in D1 minted through an admin API (a second authority to protect, for one person), and OAuth for
  MCP (every client in scope takes a static header).

### Access

- Two self-hosted Access applications: the app (`APP_HOST`) and content (`*` + `CONTENT_HOST_SUFFIX`). Each has a
  policy that admits only the owner, and the `CF_Authorization` cookie set to HttpOnly explicitly, because the
  documentation states its default inconsistently
  ([authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)).
  The cookie is per host; other hosts of the application get one through a redirect without a new sign-in, and a
  wildcard host cannot get one in advance.
- The Worker verifies the `Cf-Access-Jwt-Assertion` header on the app and private content hosts, as kopje does: jose,
  the key set from the team domain's certificate endpoint reused for at most 7 days, RS256, issuer, the audience of that
  host class, `exp` required, 60 s clock tolerance, a 5 s timeout on fetching keys, and only reason codes on failure
  (ACC-1). A misconfigured route or Access application then fails closed instead of serving.
- The Worker does not compare the email: the Access policy is the one place that names the owner, and the audience
  proves the request passed it.

### Public share links

- An artifact has a `public` flag, set through the API (`PATCH /v1/artifacts/{id}`, MCP `set_public`). It is refused
  with `public_disabled` when `PUBLIC_HOST_SUFFIX` is not configured.
- The public host serves a public artifact's latest and pinned versions with the rules of section 5 and no Access.
  An unknown, private or deleted artifact answers the same 404 (PUB-1). The public host never serves the gallery or the
  API.
- A share link follows updates; a pinned URL on the public host shares one version.

## 7. REST API and MCP

### Operations

| Operation              | REST                                                           | MCP tool                      | Result                                            |
| ---------------------- | -------------------------------------------------------------- | ----------------------------- | ------------------------------------------------- |
| Create                 | `POST /v1/artifacts` (multipart)                               | `create_artifact`             | 201 `{ artifact, version }`                       |
| Update                 | `POST /v1/artifacts/{id}/versions` (multipart)                 | `update_artifact`             | 201 `{ artifact, version }`                       |
| List                   | `GET /v1/artifacts?limit=&cursor=`                             | `list_artifacts`              | `{ artifacts, next_cursor }`                      |
| Get                    | `GET /v1/artifacts/{id}`                                       | `get_artifact`                | `{ artifact, version }`, latest with files        |
| Get a version          | `GET /v1/artifacts/{id}/versions/{n}`                          | `get_artifact` with `version` | `{ artifact, version }` with files                |
| List versions          | `GET /v1/artifacts/{id}/versions?limit=&cursor=`               | `list_versions`               | `{ versions, next_cursor }`, without files        |
| Read a file            | `GET /v1/artifacts/{id}/versions/{n}/files/{path}` (raw bytes) | `read_file`                   | `{ path, content_type, size, encoding, content }` |
| Make public or private | `PATCH /v1/artifacts/{id}` with `{ "public": bool }`           | `set_public`                  | `{ artifact }`                                    |
| Delete                 | `DELETE /v1/artifacts/{id}`                                    | `delete_artifact`             | 204, or `{ deleted: id }`                         |

Inputs:

- **Create:** `title`, `description?`, `files` (at least `index.html`).
- **Update:** `id`, `base_version`, `title?`, `description?`, `files?`, `remove?`.
- **Read a file over REST:** `{path}` is resolved like a request path on a content host (section 5).
- **Read a file over MCP:** `id`, `path`, `version?`. Content is `utf8` when the type is textual and the bytes are
  valid UTF-8, `base64` otherwise; a file over 1 MiB is refused with the REST URL in the message.

Shapes (timestamps are RFC 3339 in UTC):

```json
{
  "artifact": {
    "id": "k2x7…",
    "title": "Quarterly chart",
    "description": "",
    "public": false,
    "latest_version": 3,
    "created_at": "2026-11-16T09:00:00Z",
    "updated_at": "2026-11-16T10:00:00Z",
    "url": "https://k2x7…-p.example-content.net/",
    "public_url": null,
    "gallery_url": "https://artifacts.example.com/a/k2x7…"
  },
  "version": {
    "number": 3,
    "created_at": "2026-11-16T10:00:00Z",
    "published_by": "codex",
    "title": "Quarterly chart",
    "description": "",
    "file_count": 3,
    "total_bytes": 48213,
    "url": "https://k2x7…-p.example-content.net/_v/3/",
    "files": [{ "path": "index.html", "size": 1834, "sha256": "…", "content_type": "text/html; charset=utf-8" }]
  }
}
```

### Errors

REST answers `{ "error": { "code", "message", … } }` with the status below; MCP answers a tool result with
`isError: true` and the same object, so the model reads it. Codes come from a closed set, mapped once (P5).

| Code                     | HTTP | When                                                                                  |
| ------------------------ | ---- | ------------------------------------------------------------------------------------- |
| `invalid_request`        | 400  | input fails validation; `issues` lists `{ field, reason }`, reasons from a closed set |
| `public_disabled`        | 400  | `set_public` without a public host                                                    |
| `unauthorized`           | 401  | missing or unknown token, with `WWW-Authenticate: Bearer`                             |
| `not_found`              | 404  | no live artifact, version or file                                                     |
| `method_not_allowed`     | 405  |                                                                                       |
| `version_conflict`       | 409  | `base_version` is not the latest; carries `latest_version`                            |
| `payload_too_large`      | 413  | the request body exceeds its bound                                                    |
| `unsupported_media_type` | 415  | the body is not the type the route takes                                              |
| `unavailable`            | 503  | invalid configuration, or a storage or key fetch timed out                            |
| `internal`               | 500  | anything else; the message carries no detail                                          |

### MCP server

- **Library:** `@modelcontextprotocol/server` 2.4.0, `createMcpHandler` with its default `legacy: 'stateless'`. One
  factory serves the 2026-07-28 revision and, statelessly, the 2025-era revisions the SDK lists (2024-10-07 to
  2025-11-25), which Claude Code, Codex CLI and Gemini CLI speak; `GET` and `DELETE` answer 405, as a stateless server
  does. The Worker checks the host and the bearer token before the handler, which does neither, and passes the token
  name (never the token) as `authInfo.clientId`. The request body bound stays at the SDK's 4 MiB.
- **Rejected:** Cloudflare's `agents` `McpAgent`. It keeps a Durable Object per session and depends on SDK v1 as well
  as v2; nothing here needs sessions or messages from the server.
- Tool annotations: the reads are `readOnlyHint`; `delete_artifact` is `destructiveHint` and `idempotentHint`;
  `set_public` is `idempotentHint`. Clients confirm tool calls that are not allowlisted, and the owner keeps
  `delete_artifact` and `set_public` off those allowlists.
- Every tool has an input and an output schema (section 11), so clients see `structuredContent` and its JSON Schema.

Server `instructions`:

```text
This server publishes HTML pages ("artifacts") that the owner opens in a browser. Each artifact has its own origin and
its entry page is index.html.

- create_artifact: a title and files, including index.html. Returns the artifact, version 1 and its URLs.
- update_artifact: the artifact id and base_version, the latest version you know. Files you send replace or add a
  path, paths in remove are deleted, every other file is kept. If someone published since, you get version_conflict
  with latest_version: call get_artifact and redo the change on top of it.
- Every publish makes a new version that never changes. The latest is at the artifact URL; version n stays at
  <url>/_v/n/.
- Link between your files with relative URLs (style.css, img/logo.png), never /style.css or a full URL to the artifact,
  so that old versions load their own files.
- Text files use encoding "utf8"; binary files use "base64". The content type follows the file extension unless you
  give content_type.
- Paths are relative and /-separated, with no empty, "." or ".." segments, no segment starting with ".", and not
  starting with "_v/". At most 1000 files per version, 25 MiB per file, about 4 MiB per call. For larger files, use the
  REST API or the CLI.
- Artifacts are visible only to the owner until set_public makes one readable by anyone with its public URL. Never put
  secrets in an artifact.
```

## 8. CLI

- **Commands:** `artifacts publish <dir> [--id <id>] [--title <t>] [--description <d>]`, `artifacts list`,
  `artifacts get <id> [--version <n>]`, `artifacts public <id> on|off`, `artifacts delete <id>`; `--json` prints the
  API's JSON. Configuration: `ARTIFACTS_API_URL` (the API host's origin) and `ARTIFACTS_TOKEN`.
- **`publish` without `--id`** creates an artifact from the directory; `--title` is required. **With `--id`** it reads
  the latest version, compares each local file's SHA-256 with the version's list, sends only new and changed files,
  removes paths the directory no longer has, and sends the version it read as `base_version`. A conflict means
  someone published after the read; the CLI reports it and does not retry.
- **Directory mapping:** every regular file below the directory, by its relative POSIX path in NFC. Entries whose name
  starts with `.` are skipped, matching the path rules. A symbolic link is an error, so a link cannot pull a file from
  outside the directory into an artifact. The CLI checks the root `index.html`, the file count and the file size before
  sending, and refuses a publish whose new bytes exceed the REST request bound instead of splitting it.
- **Distribution:** TypeScript without runtime dependencies (`node:util` `parseArgs`, `fetch`, `FormData`,
  `fs.openAsBlob`), run by Node 24 from a checkout of this repository and put on `PATH` by a symbolic link to its entry
  file. Node strips types from files outside `node_modules`, so no build step exists.
- **Rejected:** an npm package (type stripping does not apply under `node_modules`, so it would need a build and a
  publication for one user) and a single-file bundle (a build with nothing to bundle while there are no dependencies;
  it becomes the choice if the CLI gains one).

## 9. Gallery

Server-rendered HTML on `APP_HOST`, without script, forms or frames; the owner designs the screens later, so this
fixes content and behavior only.

| Page      | Shows                                                                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`       | Live artifacts, most recently updated first, 50 per page with a link to the next: title, the start of the description, update time, latest version, whether it is public, links to the artifact and its page                                                           |
| `/a/<id>` | Title, description, the artifact URL and the public URL if public, creation and update times; the versions, newest first, with number, time, `published_by`, title, file count, size and a link to the pinned URL; the latest version's files with path, size and type |

Anything else, and a deleted artifact, answers 404. The gallery links to artifacts and does not frame them: how Access
behaves in a frame is not documented, and a content host is another site in the recommended layout. Every artifact
text is escaped, and the response's CSP forbids scripts and framing (ISO-5). Nothing on it changes state (ISO-3).

## 10. Operations

- **Configuration split, as zenith.** `wrangler.jsonc` (public) holds the name, entry, compatibility date,
  `workers_dev: false`, `preview_urls: false`, the D1 binding `DB` with its migrations, the R2 binding `FILES`, and
  observability with invocation logs off. The gitignored `wrangler.deploy.jsonc` (an example file is committed) holds
  the account, the routes and custom domains, the database and bucket identifiers, and the variables `APP_HOST`,
  `API_HOST`, `CONTENT_HOST_SUFFIX`, `PUBLIC_HOST_SUFFIX`, `ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD` and
  `ACCESS_CONTENT_AUD`. `API_TOKENS` is a secret. A deployment script checks the deployment file with the Worker's own
  configuration parser, refuses `localhost` hosts, merges the two files and runs `wrangler deploy` (DATA-2, ACC-2).
- **Cloudflare setup by the owner:** the proxied wildcard DNS record, the two Access applications (owner-only policy,
  HttpOnly cookie), the D1 database, and an R2 bucket with no public access.
- **Logging:** only `logEvent(event, fields)` writes to the console, with an event name and fields from closed sets:
  reason codes, error classes, token names, artifact IDs, version numbers and counts. It never records a token, an
  `Authorization` header, an Access JWT or cookie, file bytes, titles, descriptions or paths (DATA-1). Every change
  (create, version, visibility, delete) logs its token name, so the 7 days of Workers Logs on Paid show what a leaked
  token did. Invocation logs are off: they record the request
  ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)).
- **Backups:** not in the first release. D1 Time Travel restores metadata for 30 days, which covers a bug that damages
  rows; restoring past a delete brings back rows whose objects are gone. R2 bytes have no second copy. Artifacts are
  agent output that can be produced again, and the risk a backup would cover, deletion with a leaked token, is answered
  by revoking the token. This is revisited when an artifact is the only copy of something the owner needs.

## 11. Libraries

Recorded in [decisions.md](decisions.md): plain `fetch` routing, zod 4 schemas shared by REST and MCP, jose for
Access, `mime/lite`, own ID generation, and the MCP SDK as above.

## Accepted side effects

| Side effect                                                                | What is not lost, and why                                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages must use relative URLs between their files                           | The latest version works either way; only pinned views of a page with root-relative URLs load the latest file. The MCP instructions state the rule. |
| An artifact's service worker and storage span all its versions             | Server bytes are immutable; the page's own code is the only thing that can alter what its origin shows, and clearing site data resets it.           |
| Unreferenced R2 objects after failed, raced or interrupted operations      | No version references them and serving reads only `version_files`, so nothing visible changes. They cost storage until their prefix is deleted.     |
| First visit to each artifact host redirects through Access                 | No new sign-in while the Access session lasts; the cookie is per host by Access's design.                                                           |
| Shared-domain layout: a proxied wildcard DNS record for the owner's domain | Every host with its own record keeps resolving as before; only names without a record now reach Cloudflare and get an error instead of NXDOMAIN.    |
| Large binaries cannot go through MCP                                       | REST and the CLI take them; MCP stays usable for pages a model writes.                                                                              |
| No `Range` support                                                         | Pages, images, fonts and scripts load whole; only seeking in audio and video is missing.                                                            |
| No version pruning, no backup of bytes                                     | Every version stays viewable; deleting an artifact removes it whole. What a backup would protect is regenerable agent output (section 10).          |

## Deferred

| Item                          | Reason                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Version pruning               | section 4                                                                      |
| Backups of R2 bytes           | section 10                                                                     |
| `Range` requests              | the first release serves HTML assets; media seeking is not in its scope        |
| Splitting a large CLI publish | intermediate versions would show partial states; the bound is reported instead |
| Gallery previews and search   | not requested; previews would frame artifacts (section 9)                      |

## Purpose layer: acceptance criteria

Each criterion comes from the agreed scope: **Interfaces** (MCP and REST from one implementation, a thin CLI),
**Auth** (Access for browsers, bearer tokens for agents, optional public links), **Domain** (a host per artifact), and
**Features** (publish, read, list, delete; version history; multiple files; gallery). Each is checked on the deployed
Worker with real clients and a browser.

| ID    | Requirement (EARS)                                                                                                                                                         | Source                             | Scenario                                                                                                                                                              | Pass, and failure                                                                                                        | Checked on                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| AC-1  | When an agent calls `create_artifact` over MCP with an `index.html`, the system shall return a URL that shows that page.                                                   | Interfaces; Features (publish)     | Claude Code, Codex CLI and Gemini CLI, each configured with `/mcp` and its own token, publish a page                                                                  | The result holds a URL that renders the page after Access sign-in. Fails: no connection, a tool error, no page           | each client against the deployed Worker; a browser       |
| AC-2  | When the CLI publishes a directory, the system shall serve every file in it at the artifact URL with relative links working.                                               | Interfaces (CLI); Features (files) | A directory with `index.html`, a stylesheet, a script and a PNG                                                                                                       | Styled page, script runs, image shows, each with its type. Fails: a 404 or a wrong type in the network panel             | the CLI against the deployed Worker; a browser           |
| AC-3  | When an agent updates an artifact, the system shall serve the new version at the artifact URL and keep every earlier version at its pinned URL.                            | Features (version history)         | Two updates through MCP                                                                                                                                               | `/` shows version 3; `/_v/1/` and `/_v/2/` show theirs. Fails: an old version changed or missing                         | a real MCP client; a browser                             |
| AC-4  | When an agent lists, reads or deletes artifacts, the system shall answer with their current state, and after a delete the artifact's URLs and gallery entry shall be gone. | Features (list, read, delete)      | List, `get_artifact`, `read_file`, `delete_artifact`, then open the old URLs                                                                                          | Results match what was published; after delete every URL answers 404. Fails: stale or surviving content                  | a real MCP client and the CLI; a browser                 |
| AC-5  | When the owner opens the gallery, the system shall list the artifacts with their versions and links and offer nothing that changes state.                                  | Features (gallery)                 | Browse `/` and an artifact's page                                                                                                                                     | Every artifact and version is listed with working links; no forms or scripts. Fails: missing entries                     | a browser on the deployed app host                       |
| AC-6  | While a browser is not signed in to Access as the owner, the system shall serve neither the gallery nor a private artifact.                                                | Auth (Access)                      | A private window; then sign in with an identity other than the owner's                                                                                                | Access sign-in, then denial. Fails: any artifact byte or gallery entry                                                   | a browser on the deployed hosts                          |
| AC-7  | If a request to the REST API or `/mcp` carries no valid token, then the system shall answer 401 and change nothing.                                                        | Auth (bearer tokens)               | `curl` without a token, with a wrong one and with a revoked one, to each route                                                                                        | 401 everywhere; the gallery is unchanged. Fails: any other status or a change                                            | `curl` against the deployed API host                     |
| AC-8  | While an artifact page runs in the owner's browser, the system shall not let its script read another artifact, the gallery, the API or its Access cookie.                  | Domain (origin isolation)          | A probe artifact whose script fetches another artifact, the gallery and the API, reads `document.cookie` and another artifact's `localStorage`, and shows the results | Every read fails. Fails: any content, cookie or storage value read                                                       | a browser on the deployed content hosts                  |
| AC-9  | When the owner makes an artifact public, the system shall serve it at its public URL without sign-in, and when made private again, the public URL shall answer 404.        | Auth (public links)                | `artifacts public <id> on`, open the public URL in a private window, then `off`                                                                                       | Page renders without sign-in; then 404. Fails: sign-in demanded, or content after `off`                                  | the CLI and a private window against the deployed Worker |
| AC-10 | If two agents update one artifact from the same version, then the system shall commit one update and answer the other with a conflict.                                     | Features (version history)         | Two CLI publishes started together with the same base                                                                                                                 | One new version; the other gets `version_conflict`; neither's files are mixed. Fails: two versions or a silent overwrite | two CLI processes against the deployed Worker            |
| AC-11 | When a client connects to `/mcp`, the system shall give the publishing contract in its instructions.                                                                       | Interfaces (MCP)                   | An agent given only the server publishes a multi-file page, then updates it                                                                                           | Its pinned and latest URLs both render with their own files. Fails: root-relative links or a misused update              | a real MCP client; a browser                             |

## Plan layer

Claims derived from the purpose layer, each checked by a test that runs without the deployed Worker (unit tests, or
the Worker in the local runtime with D1 and R2). Threat-model IDs name the invariant the claim belongs to.

| ID    | Claim (EARS)                                                                                                                                                                                                              | Source        | Test                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| PL-1  | If a request's host is not the app host, the API host, or an ID followed by a configured suffix, then the Worker shall answer 404 without reading storage.                                                                | HOST-1        | routing: hosts with an extra label, uppercase, a 25- or 27-character prefix, a port, a hyphen               |
| PL-2  | If the configuration has overlapping suffixes, an app or API host under a suffix, a mix of `localhost` and other hosts, or a malformed value, then the Worker shall answer 503 and the deployment script shall refuse it. | HOST-2, ACC-2 | configuration and deployment-script tests, one per refusal                                                  |
| PL-3  | If a request to the app host or a private content host has no valid Access JWT, then the Worker shall answer 403 and read no artifact data.                                                                               | ACC-1         | Worker test with a local key set: missing, bad signature, other issuer, the other class's audience, expired |
| PL-4  | The Worker shall take the Access JWT only from `Cf-Access-Jwt-Assertion`.                                                                                                                                                 | ACC-1, ISO-4  | a valid JWT sent only as a cookie is refused; source analysis for cookie reads                              |
| PL-5  | While the configured hosts are not all `localhost` names, the Worker shall verify Access on every app and private content request.                                                                                        | ACC-2         | Worker test with production-shaped hosts and no JWT                                                         |
| PL-6  | If a request to the API host has no bearer token whose SHA-256 is in `API_TOKENS`, then the Worker shall answer 401 and change nothing.                                                                                   | TOK-1         | Worker test on every REST route and `/mcp`: no header, other scheme, unknown and removed tokens             |
| PL-7  | The Worker shall compare token hashes with `crypto.subtle.timingSafeEqual` against every entry.                                                                                                                           | TOK-1         | source analysis of the token check                                                                          |
| PL-8  | When a version is committed, the system shall record the name of the token that published it.                                                                                                                             | TOK-3         | publish with two tokens; versions carry their names                                                         |
| PL-9  | The Worker shall not put a token, an `Authorization` header, an Access JWT, file bytes, a title, a description or a path in a log line.                                                                                   | TOK-2, DATA-1 | log redaction with markers through every route and failure path; source analysis for `console`              |
| PL-10 | When a content host is requested, the Worker shall serve only files of the artifact its host names.                                                                                                                       | ISO-1         | another artifact's path on this host answers 404                                                            |
| PL-11 | If an ID was ever used, then creating an artifact shall not reuse it.                                                                                                                                                     | ISO-1         | delete, then create with the ID generator stubbed to return the old ID                                      |
| PL-12 | The Worker shall send no `Access-Control-Allow-*` header on any host.                                                                                                                                                     | ISO-2         | every route, including `OPTIONS` and error answers                                                          |
| PL-13 | If a request to the app host or a content host uses a method other than GET or HEAD, then the Worker shall answer 405.                                                                                                    | ISO-3         | each method on each host class                                                                              |
| PL-14 | The Worker shall set no cookie.                                                                                                                                                                                           | ISO-4         | no `Set-Cookie` on any route; source analysis                                                               |
| PL-15 | When the gallery renders artifact text, the Worker shall escape it and send a CSP that forbids scripts and framing.                                                                                                       | ISO-5         | titles and descriptions holding markup and attribute breakouts                                              |
| PL-16 | When a file is served, the Worker shall send its stored type, `nosniff` and `Referrer-Policy: no-referrer`.                                                                                                               | SRV-1         | Worker test per host class                                                                                  |
| PL-17 | When the latest version is served, the Worker shall send `no-cache` with the file's ETag and answer a matching `If-None-Match` with 304; a pinned version shall be `immutable`.                                           | section 5     | Worker test                                                                                                 |
| PL-18 | If a request path has a malformed escape, invalid UTF-8, an encoded `/` or a dot segment, then the Worker shall answer 404.                                                                                               | SRV-2         | `%2e%2e`, `%2F`, `%C0%AF`, `%`, NFD input for an NFC path (served)                                          |
| PL-19 | When a path names a directory with an `index.html`, the Worker shall serve it at `dir/` and redirect `dir` with 308.                                                                                                      | section 5     | Worker test, including `/_v/<n>`                                                                            |
| PL-20 | If `/_v/<n>/` names a version that does not exist or `<n>` is not canonical, then the Worker shall answer 404.                                                                                                            | section 4     | `0`, `01`, `+1`, one past the latest                                                                        |
| PL-21 | When the public host is asked for an artifact that is private, deleted or unknown, the Worker shall answer the same 404.                                                                                                  | PUB-1         | compare the three responses byte for byte                                                                   |
| PL-22 | When an artifact is made private, the public host shall answer 404 for it from the next request.                                                                                                                          | PUB-1         | Worker test                                                                                                 |
| PL-23 | If no public suffix is configured, then making an artifact public shall fail with `public_disabled`.                                                                                                                      | PUB-2         | REST and MCP                                                                                                |
| PL-24 | If a publish fails before its commit, then no new version shall be visible.                                                                                                                                               | VER-2         | inject a failure at each upload, a timeout, and a failing batch; listings and serving unchanged             |
| PL-25 | If `base_version` is not the latest, then an update shall answer 409 with `latest_version` and commit nothing.                                                                                                            | VER-3         | stale base; two concurrent updates from one base commit exactly one                                         |
| PL-26 | If an artifact is deleted while an update is in flight, then the update shall commit no version.                                                                                                                          | VER-3, VER-4  | delete between upload and commit                                                                            |
| PL-27 | When a file is stored, its key shall be `a/<id>/` and the SHA-256 of its bytes.                                                                                                                                           | VER-1, VER-4  | R2 contents after publishes that share and change files                                                     |
| PL-28 | When an artifact is deleted, the system shall remove its rows and every object under its prefix.                                                                                                                          | VER-4         | R2 and D1 contents after delete                                                                             |
| PL-29 | When an update omits a file, the new version shall keep the base's entry; a removed path shall be gone; a provided path shall be replaced; a result without `index.html` shall be refused.                                | section 4     | table of update cases                                                                                       |
| PL-30 | If an input exceeds a bound of section 5, then the system shall refuse it before any write.                                                                                                                               | RES-1         | at and one past each bound in its unit, with astral and multibyte characters                                |
| PL-31 | If a request body exceeds its bound while being read, then the Worker shall stop reading and answer 413.                                                                                                                  | RES-1         | chunked body without `Content-Length`                                                                       |
| PL-32 | If a key fetch or a storage call exceeds its timeout, then the request shall answer 503 and leave no version.                                                                                                             | RES-2         | stubbed slow key endpoint and slow R2                                                                       |
| PL-33 | When an operation runs through REST and through MCP with the same input, the system shall give the same result or error code.                                                                                             | P5, section 7 | one table of cases run through both adapters                                                                |
| PL-34 | When a client speaking 2025-03-26, 2025-06-18 or 2025-11-25 lists and calls tools without a session, `/mcp` shall serve it, and `GET` shall answer 405.                                                                   | section 7     | the SDK's client against the Worker in the local runtime, per revision                                      |
| PL-35 | The repository shall hold no deployment values: `wrangler.jsonc` sets no variable and no route.                                                                                                                           | DATA-2        | configuration test                                                                                          |
