# artifacts

A personal, self-hosted artifact host on Cloudflare Workers: AI agents publish HTML pages and their files over MCP,
a REST API or a CLI, and each artifact is served from its own origin behind Cloudflare Access.

Status: under construction.

- [Design](docs/design.md): purpose, principles, decisions and acceptance criteria
- [Threat model](docs/threat-model.md): assets, adversaries and security invariants
- [Decisions](docs/decisions.md): libraries and code patterns
- [Operations](docs/operations.md): Cloudflare setup, releases and deployment, tokens, clients, checks and restore

## Development

Tool versions come from `mise.toml` and, for Node.js, `.node-version` (which Workers Builds reads too), with exact
versions pinned in `mise.lock`; the daily mise update workflow advances them within each major. A new Node.js major
moves by hand: change `.node-version` and `engines.node` in `package.json` and `packages/cli/package.json`, then run
`mise lock`.

```sh
mise install                # Node.js, pnpm, Bun (the CLI's runtime) and the workflow linters
pnpm install                # dependencies
pnpm exec lefthook install  # git hooks (optional)
pnpm run lint               # oxlint with type-aware rules
pnpm run fmt                # oxfmt check (pnpm run fmt:fix to apply)
pnpm run typecheck          # TypeScript
pnpm run test               # Vitest (the CLI's unit tests under Bun)
pnpm --filter @artifacts/worker exec playwright install chromium firefox webkit  # the browser tests' browsers
pnpm run test:browser       # Playwright: the viewer frame in Chromium, Firefox and WebKit
```

The GitHub repository settings are declared in `.github/infra.yaml`; review
them with `gh infra plan` and apply them with `gh infra apply`.

The daily mise update workflow opens its pull requests as a GitHub App. `pnpm run github-app` creates that App from a
manifest in the browser, stores `APP_CLIENT_ID` and `APP_PRIVATE_KEY` on the repository, and opens the App's
installation page; install it on this repository only.
