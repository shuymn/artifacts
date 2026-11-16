# artifacts CLI

A thin client over the REST API ([design](../../docs/design.md#9-cli)). Node 24 runs the TypeScript source from a
checkout and strips its types, so there is no build step and no runtime dependency.

```sh
ln -s "$PWD/packages/cli/src/main.ts" ~/.local/bin/artifacts   # any directory on PATH
export ARTIFACTS_API_URL=https://artifacts-api.example.com
export ARTIFACTS_TOKEN=art_...                                  # from `artifacts token <name>`
artifacts help
artifacts publish ./site --title "Quarterly chart"
```

`artifacts token <name>` needs no configuration: it prints a new token and the entry to add to the Worker's
`API_TOKENS` secret.
