# artifacts

A personal, self-hosted artifact host on Cloudflare Workers: AI agents publish HTML pages and their files over MCP,
a REST API or a CLI, and each artifact is served from its own origin behind Cloudflare Access.

Status: under construction. The design is in [docs/design.md](docs/design.md) once it lands.

## Development

Tool versions come from `mise.toml`, with exact versions pinned in `mise.lock`.

```sh
mise install                # Node.js, pnpm and the workflow linters
pnpm install                # dependencies
pnpm exec lefthook install  # git hooks (optional)
pnpm run lint               # oxlint with type-aware rules
pnpm run fmt                # oxfmt check (pnpm run fmt:fix to apply)
pnpm run typecheck          # TypeScript
pnpm run test               # Vitest
```

The GitHub repository settings are declared in `.github/infra.yaml`; review
them with `gh infra plan` and apply them with `gh infra apply`.

The daily mise update workflow opens its pull requests as a GitHub App. `pnpm run github-app` creates that App from a
manifest in the browser, stores `APP_CLIENT_ID` and `APP_PRIVATE_KEY` on the repository, and opens the App's
installation page; install it on this repository only.
