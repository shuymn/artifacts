# artifacts CLI

A thin client over the REST API ([design](../../docs/design.md#9-cli)), whose one runtime dependency is `oauth4webapi`
for signing in. Each release carries it as a single binary per platform, built with `bun build --compile` with the
dependency bundled; from a checkout, Bun runs the TypeScript source after `pnpm install`.

## Install

With [mise](https://mise.jdx.dev/)'s github backend, which picks this platform's archive from the latest release:

```sh
mise use -g github:shuymn/artifacts
artifacts --version
```

Or take this platform's archive and `SHA256SUMS` from a [release](https://github.com/shuymn/artifacts/releases), check
it, and unpack the binary at the archive's root (`artifacts`, or `artifacts.exe` on Windows) into a directory on `PATH`:

```sh
v=vX.Y.Z; archive=artifacts-$v-linux-x64-gnu.tar.gz
curl -fsSLO "https://github.com/shuymn/artifacts/releases/download/$v/$archive"
curl -fsSLO "https://github.com/shuymn/artifacts/releases/download/$v/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS      # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
tar -xzf "$archive" -C ~/.local/bin
```

| Platform            | Archive                                   |
| ------------------- | ----------------------------------------- |
| macOS arm64         | `artifacts-vX.Y.Z-darwin-arm64.tar.gz`    |
| Linux x64 (glibc)   | `artifacts-vX.Y.Z-linux-x64-gnu.tar.gz`   |
| Linux arm64 (glibc) | `artifacts-vX.Y.Z-linux-arm64-gnu.tar.gz` |
| Windows x64         | `artifacts-vX.Y.Z-windows-x64-msvc.zip`   |

- Linux binaries need glibc; musl systems such as Alpine are not supported.
- The macOS binary is signed ad hoc, not notarized. A browser marks what it downloads as quarantined, and macOS then
  refuses to run the binary; download with `curl` or mise, or remove the mark with
  `xattr -d com.apple.quarantine artifacts`.

## Use

```sh
export ARTIFACTS_API_URL=https://artifacts-api.example.com
artifacts login                                    # signs in through the browser; or set ARTIFACTS_TOKEN
artifacts help
artifacts publish ./site --title "Quarterly chart"
artifacts grants                                   # every OAuth grant: publisher, client, redirect host, …
artifacts revoke -- <grant>                        # revokes a grant by its ID and its tokens
artifacts logout                                   # revokes the login's grant and removes the login
```

`artifacts login` opens the API's consent page in the browser and stores the login in
`$XDG_CONFIG_HOME/artifacts/credentials.json` (`~/.config/artifacts/` when unset), readable by the owner only; commands
refresh it as needed. While `ARTIFACTS_TOKEN` (an API token from `artifacts token <name>`) is set, commands use it and
do not read the stored login. On Windows, which cannot keep the file private, `login` and `logout` refuse and every
command needs `ARTIFACTS_TOKEN`.

`artifacts grants` lists the OAuth grants, newest first: each one's ID, publisher name, client, redirect host,
resource, creation and expiry, with `-` for a field the grant lacks. `artifacts revoke <grant>` revokes one by its ID;
an ID can start with `-`, so give it after `--`. Both work with `ARTIFACTS_TOKEN` or the stored login, on every
platform. Revoking the stored login's grant ends that login: it stays in the file, commands with it fail and name
`artifacts login`, and `artifacts logout` removes it.

`artifacts token <name>` needs no configuration: it prints a new token and the entry to add to the Worker's
`API_TOKENS` secret. The binary reads its configuration from the environment only, never from a `.env` or
`bunfig.toml` in the directory it runs in.

## Development

With the tools of `mise.toml` (Bun among them), from the repository root:

```sh
ln -s "$PWD/packages/cli/src/main.ts" ~/.local/bin/artifacts   # Bun runs the source
pnpm --filter @artifacts/cli run test    # unit tests on Bun; e2e against the Worker on Node, login included
pnpm --filter @artifacts/cli run build   # this platform's release archive, in packages/cli/dist
pnpm --filter @artifacts/cli run smoke   # the smoke tests against the binary in that archive
```

`build` and `smoke` are what CI runs on each platform's runner (`.github/workflows/cli-binaries.yml`). The binary
prints the root package's version, which release-please sets for each release.
