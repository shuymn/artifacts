/**
 * The `artifacts` command (design.md section 9): a thin client over the REST API. `run` parses a command line, runs
 * one command against the API and returns the exit status; everything it touches outside the file system comes in
 * through `Io`, so tests run it against a Worker in the local runtime.
 */
import { parseArgs } from "node:util";

import rootPackage from "../../../package.json" with { type: "json" };
import {
  Api,
  ApiError,
  TIMEOUTS,
  type ArtifactJson,
  type ArtifactVersion,
  type Fetch,
  type GrantJson,
  type Timeouts,
} from "./api.ts";
import { readConfig, readOrigin, SET_TOKEN_OR_SIGN_IN, storesLogin, type Config, type Environment } from "./config.ts";
import { CliError, EXIT, UsageError, type ExitStatus } from "./errors.ts";
import { LOCK_OPTIONS, type LockBarriers } from "./lock.ts";
import { login, logout, systemOpener, type LoginContext } from "./login.ts";
import { OAUTH_REQUEST_MS } from "./oauth.ts";
import { create, listAll, update } from "./publish.ts";
import { pull } from "./pull.ts";
import {
  StaticCredential,
  StoredLogin,
  type Credential,
  type SessionBarriers,
  type SessionContext,
} from "./session.ts";
import { Store, storeDirectory, type StoreBarriers } from "./store.ts";
import { generateToken } from "./token.ts";
import { localFiles } from "./tree.ts";

/** The timing of `login`, `logout`, a refresh and the stored login's lock, and the barriers tests hold them at. */
export type SignInOptions = {
  /** Every request of `login`, `logout` and a refresh. */
  readonly requestMs: number;
  /** How long `login` waits for the browser's callback. */
  readonly callbackMs: number;
  readonly lockWaitMs: number;
  readonly lockPollMs: number;
  readonly barriers: LockBarriers & StoreBarriers & SessionBarriers;
};

export const SIGN_IN: SignInOptions = {
  requestMs: OAUTH_REQUEST_MS,
  callbackMs: 5 * 60_000,
  lockWaitMs: LOCK_OPTIONS.waitMs,
  lockPollMs: LOCK_OPTIONS.pollMs,
  barriers: {},
};

export type Io = {
  readonly env: Environment;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch: Fetch;
  readonly timeouts?: Timeouts;
  /** Artifacts per listing page; the API's largest by default. */
  readonly pageSize?: number;
  /** The platform, which decides whether a login is stored; this process's by default. */
  readonly platform?: NodeJS.Platform;
  /** Opens the authorization URL in the browser; the system's opener by default. */
  readonly openBrowser?: (url: string) => void;
  readonly signIn?: Partial<SignInOptions>;
  readonly now?: () => number;
};

/** The release version: the root package's, which `bun build --compile` inlines into the binary. */
export const VERSION: string = rootPackage.version;

/** The authoring rule, in the same words as the MCP instructions and the REST reference (design.md section 4). */
const AUTHORING_RULE =
  "Link between an artifact's files with relative URLs (style.css, img/logo.png), percent-encoding each segment (\\ as\n" +
  "%5C). A root-relative or absolute link to the artifact's own host loads the latest version's file when an older\n" +
  "version is viewed.";

/** The commands and configuration of the stored login, which only a platform that stores one offers. */
const LOGIN_COMMANDS = `
  login                               Sign in through the browser with OAuth and store the login for
                                      ARTIFACTS_API_URL's origin; commands use it while ARTIFACTS_TOKEN is unset.
  logout                              Revoke the stored login's grant, then remove the login.`;

/** The commands over the OAuth grants, which work with either credential on every platform. */
const GRANT_COMMANDS = `
  grants                              Every OAuth grant, newest first: its ID and publisher name, the client, the
                                      redirect host, the resource, when it was made and when it expires ("-" for a
                                      field the grant lacks).
  revoke <grant>                      Revoke the grant with that ID and its tokens. Put an ID that starts with "-"
                                      after "--": artifacts revoke -- <grant>.`;

const CREDENTIAL_LINES = {
  login: `  ARTIFACTS_TOKEN     An API token. It is sent as a bearer token and never printed. While it is set, commands
                      use it and do not read the stored login.
  XDG_CONFIG_HOME     login stores its tokens in $XDG_CONFIG_HOME/artifacts/credentials.json
                      (~/.config/artifacts/ when unset), readable by the owner only and never printed.`,
  token: `  ARTIFACTS_TOKEN     An API token. It is sent as a bearer token and never printed. This platform keeps no
                      stored login, so every command needs it.`,
};

/** The help text; on Windows, without `login` and `logout` (design.md section 9). */
export function helpText(platform: NodeJS.Platform): string {
  const logins = storesLogin(platform);
  return `Usage: artifacts <command> [options]

Publishes HTML pages ("artifacts") to an artifacts host through its REST API. Each artifact has its own origin;
every version needs index.html at its root.

Commands:
  publish <dir> --title <t> [--description <d>]
      Create an artifact from every file below <dir>. <dir> may also be one .html or .htm file, published as
      index.html. If the create gets no answer, publish lists the artifacts and reports the one it made (same
      title, description and files) before creating again.
  publish <dir> --id <id> [--title <t>] [--description <d>]
      Publish a new version: send new and changed files, remove the paths <dir> lacks, keep the rest, and keep the
      title and description unless given. It builds on the latest version it reads; if another version lands
      first, it reports version_conflict and publishes nothing.
  list [--archived only|include]      Every artifact, all pages; archived ones are left out unless asked for.
  get <id> [--version <n>]            The artifact and its latest version (or version n) with its files.
  pull <id> <dir> [--version <n>]     Write the latest version's files (or version n's) into a new or empty <dir>.
  public <id> on|off                  Serve every version at the artifact's public URL without sign-in, or stop.
  archive <id> on|off|auto            Archive the artifact, keep it out of the archive, or archive it by age.
  delete <id>                         Delete the artifact: every URL answers 404.
  token <name>                        Generate an API token. Prints the token once, then its API_TOKENS entry.${
    logins ? LOGIN_COMMANDS : ""
  }${GRANT_COMMANDS}
  help                                Print this text.
  --version                           Print the CLI's version.

Options:
  --json   Print the API's JSON instead of text (list: every page's artifacts in one object).

Configuration (environment):
  ARTIFACTS_API_URL   The API origin, such as https://artifacts-api.example.com (http only for localhost).
${logins ? CREDENTIAL_LINES.login : CREDENTIAL_LINES.token}

Directories:
  - Every regular file below <dir> is published under its relative path, /-separated, in NFC.
  - Names starting with "." are skipped, so .env and .git/ are never published.
  - A symbolic link to a file or directory inside <dir> is followed, and its files are published under the link's
    path as well as the target's. A link that leaves <dir>, points to a directory above itself (a loop) or is
    broken stops the publish.
  - Paths do not start with "_v/" or "cdn-cgi/" and are at most 1 KiB of UTF-8. At most 2000 files and 32 MiB
    per request: a larger publish is refused, not split into versions.

Authoring:
${AUTHORING_RULE}
Every publish makes a new version that never changes: the latest is at the artifact URL, version n at <url>/_v/n/.
Artifacts are visible only to the owner until made public; a public artifact shows all its versions. Never put
secrets in an artifact.

Exit status: 0 on success, 1 on an error, 2 on a usage error.
`;
}

/** This process's help text. */
export const HELP = helpText(process.platform);

const OPTIONS = {
  id: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  version: { type: "string" },
  archived: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type OptionName = keyof typeof OPTIONS;

type Context = {
  readonly io: Io;
  readonly args: readonly string[];
  readonly values: ReturnType<typeof parse>["values"];
  readonly api: () => Api;
  /** What `login` and `logout` work with; refused where no login is stored. */
  readonly signIn: (command: string) => LoginContext;
  /** The grant of the stored login `api` sent with; undefined when it sent `ARTIFACTS_TOKEN` or nothing yet. */
  readonly storedGrant: () => string | undefined;
  readonly print: (text: string) => void;
  readonly json: (value: unknown) => void;
};

type Command = {
  readonly usage: string;
  readonly args: number;
  readonly options: readonly OptionName[];
  readonly run: (context: Context) => Promise<void>;
};

const ID = /^[a-z2-7]{26}$/;

function artifactId(value: string | undefined): string {
  if (value === undefined || !ID.test(value)) throw new UsageError("an artifact ID is 26 characters of a-z and 2-7");
  return value;
}

function versionNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new UsageError("--version takes a version number: 1, 2, …");
  return n;
}

/** A grant ID as the server's library generates it (design.md section 7). */
const GRANT_ID = /^[A-Za-z0-9_-]{16}$/;

function grantId(value: string | undefined): string {
  if (value === undefined || !GRANT_ID.test(value)) {
    throw new UsageError("a grant ID is 16 characters of A-Z, a-z, 0-9, - and _; artifacts grants lists them");
  }
  return value;
}

function choice<T extends string>(value: string | undefined, choices: readonly T[], what: string): T {
  const found = choices.find((known) => known === value);
  if (found === undefined) throw new UsageError(`${what} is one of ${choices.join(", ")}`);
  return found;
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

function artifactLines(artifact: ArtifactJson): string {
  const setting = artifact.archive ?? "auto";
  const lines = [
    `${artifact.id}  ${artifact.title}`,
    `url: ${artifact.url}`,
    ...(artifact.public_url === null ? [] : [`public url: ${artifact.public_url}`]),
    `gallery: ${artifact.gallery_url}`,
    `public: ${yesNo(artifact.public)}  archived: ${yesNo(artifact.archived)} (setting: ${setting})`,
    `latest version: ${artifact.latest_version}  updated: ${artifact.updated_at}`,
  ];
  return `${lines.join("\n")}\n`;
}

function versionLines({ version }: ArtifactVersion): string {
  const lines = [
    `version ${version.number}: ${version.created_at} by ${version.published_by}, ${version.file_count} files, ` +
      `${version.total_bytes} bytes`,
    `version url: ${version.url}`,
    ...version.files.map((file) => `  ${file.size}\t${file.content_type}\t${file.path}`),
  ];
  return `${lines.join("\n")}\n`;
}

function listLine(artifact: ArtifactJson): string {
  const flags = [artifact.public ? "public" : "private", ...(artifact.archived ? ["archived"] : [])].join(",");
  return `${artifact.id}  v${artifact.latest_version}  ${artifact.updated_at}  ${flags}  ${artifact.title}\n`;
}

/**
 * A grant's field on one line: "-" for null, and control characters and line separators escaped, since a client names
 * itself when it registers and nothing else checks that name.
 */
function grantField(value: string | null): string {
  if (value === null) return "-";
  return value.replaceAll(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function grantLines(grant: GrantJson): string {
  const client =
    grant.client_name === null
      ? grantField(grant.client_id)
      : `${grantField(grant.client_name)} (${grantField(grant.client_id)})`;
  const lines = [
    `${grantField(grant.id)}  publisher: ${grantField(grant.publisher)}`,
    `  client: ${client}`,
    `  redirect host: ${grantField(grant.redirect_host)}  resource: ${grantField(grant.resource)}`,
    `  created: ${grantField(grant.created_at)}  expires: ${grantField(grant.expires_at)}`,
  ];
  return `${lines.join("\n")}\n`;
}

function issueLines(error: ApiError): string {
  return error.issues.map((issue) => `\n  ${issue.field}: ${issue.reason}`).join("");
}

const COMMANDS: Readonly<Record<string, Command>> = {
  publish: {
    usage: "publish <dir> (--title <t> | --id <id>) [--title <t>] [--description <d>]",
    args: 1,
    options: ["id", "title", "description", "json"],
    async run({ io, args, values, api, print, json }) {
      const [input = ""] = args;
      const id = values.id === undefined ? undefined : artifactId(values.id);
      if (id === undefined && values.title === undefined) {
        throw new UsageError("creating an artifact needs --title; to update one, give --id");
      }
      const files = await localFiles(input);
      if (id === undefined) {
        const result = await create(
          api(),
          files,
          { title: values.title ?? "", description: values.description },
          io.pageSize ?? 100,
        );
        if (result.recovered === true) {
          io.stderr("artifacts: the create got no answer; the listing shows the artifact it made\n");
        }
        if (values.json === true) return json({ artifact: result.artifact, version: result.version });
        print(`created ${result.artifact.id} version ${result.version.number}\n`);
        print(`url: ${result.artifact.url}\nversion url: ${result.version.url}\n`);
        return;
      }
      const result = await update(api(), files, { id, title: values.title, description: values.description });
      if (values.json === true) return json({ artifact: result.artifact, version: result.version });
      print(
        `published ${result.artifact.id} version ${result.version.number} ` +
          `(sent ${result.sent}, removed ${result.removed}, unchanged ${result.unchanged})\n`,
      );
      print(`url: ${result.artifact.url}\nversion url: ${result.version.url}\n`);
    },
  },
  list: {
    usage: "list [--archived only|include]",
    args: 0,
    options: ["archived", "json"],
    async run({ io, values, api, print, json }) {
      const archived =
        values.archived === undefined
          ? undefined
          : choice(values.archived, ["exclude", "only", "include"] as const, "--archived");
      const artifacts = await listAll(api(), archived, io.pageSize ?? 100);
      if (values.json === true) return json({ artifacts, next_cursor: null });
      print(artifacts.map(listLine).join(""));
    },
  },
  get: {
    usage: "get <id> [--version <n>]",
    args: 1,
    options: ["version", "json"],
    async run({ args, values, api, print, json }) {
      const id = artifactId(args[0]);
      const result = await api().get(id, versionNumber(values.version));
      if (values.json === true) return json(result);
      print(artifactLines(result.artifact) + versionLines(result));
    },
  },
  pull: {
    usage: "pull <id> <dir> [--version <n>]",
    args: 2,
    options: ["version", "json"],
    async run({ io, args, values, api, print, json }) {
      const id = artifactId(args[0]);
      const directory = args[1] ?? "";
      const result = await pull(api(), id, directory, versionNumber(values.version));
      if (result.dotNames.length > 0) {
        io.stderr(
          `artifacts: ${result.dotNames.length} paths have a name starting with "."; publish skips them: ` +
            `${result.dotNames.map((path) => JSON.stringify(path)).join(", ")}\n`,
        );
      }
      if (values.json === true) return json({ artifact: result.artifact, version: result.version });
      print(
        `pulled ${result.version.files.length} files of ${result.artifact.id} version ${result.version.number} ` +
          `into ${directory}\n`,
      );
    },
  },
  public: {
    usage: "public <id> on|off",
    args: 2,
    options: ["json"],
    async run({ args, values, api, print, json }) {
      const id = artifactId(args[0]);
      const state = choice(args[1], ["on", "off"] as const, "the public setting");
      const result = await api().patch(id, { public: state === "on" });
      if (values.json === true) return json(result);
      print(artifactLines(result.artifact));
    },
  },
  archive: {
    usage: "archive <id> on|off|auto",
    args: 2,
    options: ["json"],
    async run({ args, values, api, print, json }) {
      const id = artifactId(args[0]);
      const state = choice(args[1], ["on", "off", "auto"] as const, "the archive setting");
      const archive = state === "on" ? "archived" : state === "off" ? "kept" : null;
      const result = await api().patch(id, { archive });
      if (values.json === true) return json(result);
      print(artifactLines(result.artifact));
    },
  },
  delete: {
    usage: "delete <id>",
    args: 1,
    options: ["json"],
    async run({ args, values, api, print, json }) {
      const id = artifactId(args[0]);
      await api().delete(id);
      if (values.json === true) return json({ deleted: id });
      print(`deleted ${id}\n`);
    },
  },
  token: {
    usage: "token <name>",
    args: 1,
    options: [],
    async run({ io, args, print }) {
      const entry = generateToken(args[0] ?? "");
      print(`${entry.token}\n${JSON.stringify(entry.name)}: ${JSON.stringify(entry.sha256)}\n`);
      io.stderr(
        "artifacts: the token above is shown once; give it to the agent. Add the entry to the API_TOKENS secret's " +
          "JSON object to admit it, and remove the entry to revoke it.\n",
      );
    },
  },
  grants: {
    usage: "grants",
    args: 0,
    options: ["json"],
    async run({ values, api, print, json }) {
      const result = await api().grants();
      if (values.json === true) return json(result);
      print(result.grants.map(grantLines).join(""));
    },
  },
  revoke: {
    usage: "revoke <grant>",
    args: 1,
    options: [],
    async run({ io, args, api, storedGrant, print }) {
      const id = grantId(args[0]);
      try {
        await api().revokeGrant(id);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.status === 404) {
          throw new CliError(
            `${error.code}: no grant ${id} is listed; artifacts grants lists the grants, and one made moments ago ` +
              "may not be listed yet",
          );
        }
        if (error.status === 503) {
          throw new CliError(`${error.code}: the revocation may not have completed; run artifacts revoke ${id} again`);
        }
        throw error;
      }
      print(`revoked ${id}\n`);
      // The stored login stays (design.md section 9): the next command's refresh is refused and names login.
      if (storedGrant() === id) {
        io.stderr(
          "artifacts: that was the stored login's grant, which has ended; sign in again with artifacts login\n",
        );
      }
    },
  },
  login: {
    usage: "login",
    args: 0,
    options: [],
    async run({ io, signIn }) {
      const token = io.env.ARTIFACTS_TOKEN;
      await login(signIn("login"), token !== undefined && token !== "");
    },
  },
  logout: {
    usage: "logout",
    args: 0,
    options: [],
    async run({ signIn }) {
      await logout(signIn("logout"));
    },
  },
};

/** The message for an error, without any token the command holds should any text ever carry one. */
function errorText(error: unknown, platform: NodeJS.Platform, secrets: ReadonlySet<string>): string {
  let text: string;
  if (error instanceof ApiError) {
    const where = storesLogin(platform)
      ? "check ARTIFACTS_TOKEN, or sign in again with artifacts login"
      : "check ARTIFACTS_TOKEN";
    const hint = error.status === 401 ? ` (${where})` : "";
    text = `${error.code}: ${error.message}${hint}${issueLines(error)}`;
  } else if (error instanceof CliError) {
    text = error.message;
  } else if (error instanceof Error) {
    text = `unexpected ${error.name}: ${error.message}`;
  } else {
    text = "unexpected error";
  }
  // Longest first, so a token that holds another is replaced whole.
  for (const secret of [...secrets].toSorted((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[token]");
  return text;
}

function parse(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
}

export async function run(argv: readonly string[], io: Io): Promise<ExitStatus> {
  const platform = io.platform ?? process.platform;
  const secrets = new Set<string>();
  if (io.env.ARTIFACTS_TOKEN !== undefined && io.env.ARTIFACTS_TOKEN !== "") secrets.add(io.env.ARTIFACTS_TOKEN);
  const fail = (error: unknown): ExitStatus => {
    io.stderr(`artifacts: ${errorText(error, platform, secrets)}\n`);
    return error instanceof CliError ? error.exitStatus : EXIT.failure;
  };
  // Only alone: `get` and `pull` take `--version <n>`.
  if (argv.length === 1 && argv[0] === "--version") {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return fail(new UsageError(`${error instanceof Error ? error.message : "invalid arguments"}; see artifacts help`));
  }
  const [name, ...args] = parsed.positionals;
  if (parsed.values.help === true || name === undefined || name === "help") {
    io.stdout(helpText(platform));
    return EXIT.ok;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) return fail(new UsageError(`unknown command ${JSON.stringify(name)}; see artifacts help`));
  const given = Object.keys(parsed.values).filter((option) => option !== "help");
  const extra = given.find((option) => !command.options.some((allowed) => allowed === option));
  if (extra !== undefined || args.length !== command.args) {
    const problem = extra === undefined ? "wrong number of arguments" : `${name} does not take --${extra}`;
    return fail(new UsageError(`${problem}; usage: artifacts ${command.usage}`));
  }
  const options = { ...SIGN_IN, ...io.signIn };
  /** The stored login of `origin`; undefined when the environment names no directory for it. */
  const session = (origin: string): SessionContext | undefined => {
    const directory = storeDirectory(io.env);
    if (directory === undefined) return undefined;
    const lock = { waitMs: options.lockWaitMs, pollMs: options.lockPollMs, barriers: options.barriers };
    return {
      origin,
      store: new Store(directory, lock, options.barriers),
      fetch: io.fetch,
      requestMs: options.requestMs,
      now: io.now ?? Date.now,
      secrets,
      barriers: options.barriers,
    };
  };
  const credentialFor = (config: Config): Credential => {
    if (config.credential.kind === "token") return new StaticCredential(config.credential.token);
    const stored = session(config.apiOrigin);
    if (stored === undefined) throw new CliError(SET_TOKEN_OR_SIGN_IN);
    return new StoredLogin(stored);
  };
  let api: Api | undefined;
  let credential: Credential | undefined;
  const context: Context = {
    io,
    args,
    values: parsed.values,
    api: () => {
      if (api !== undefined) return api;
      const config = readConfig(io.env, platform);
      credential = credentialFor(config);
      api = new Api(config.apiOrigin, credential, io.fetch, io.timeouts ?? TIMEOUTS);
      return api;
    },
    storedGrant: () => (credential instanceof StoredLogin ? credential.grant() : undefined),
    signIn: (commandName) => {
      if (!storesLogin(platform)) {
        throw new CliError(
          `${commandName} is not offered on Windows, which cannot keep a stored login private; ` +
            "set ARTIFACTS_TOKEN to an API token instead",
        );
      }
      const stored = session(readOrigin(io.env));
      if (stored === undefined) throw new CliError("set HOME or XDG_CONFIG_HOME, below which the login is stored");
      return {
        ...stored,
        callbackMs: options.callbackMs,
        openBrowser: io.openBrowser ?? systemOpener(platform),
        print: io.stdout,
        note: io.stderr,
      };
    },
    print: io.stdout,
    json: (value) => io.stdout(`${JSON.stringify(value, null, 2)}\n`),
  };
  try {
    await command.run(context);
    return EXIT.ok;
  } catch (error) {
    return fail(error);
  }
}
