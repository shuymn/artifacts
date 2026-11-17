/** Exit statuses of the command: 0 on success, 1 on an error, 2 on a usage error. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;
export type ExitStatus = (typeof EXIT)[keyof typeof EXIT];

/** The `code` of a Node system error (`ENOENT`, `ECONNRESET`, …), never its message. */
export function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** A failure the command reports in one message and ends with. */
export class CliError extends Error {
  override readonly name: string = "CliError";
  readonly exitStatus: ExitStatus;

  constructor(message: string, exitStatus: ExitStatus = EXIT.failure) {
    super(message);
    this.exitStatus = exitStatus;
  }
}

/** A command line the command does not take. */
export class UsageError extends CliError {
  override readonly name: string = "UsageError";

  constructor(message: string) {
    super(message, EXIT.usage);
  }
}

/**
 * A failure after which the command could not remove a file it made: the failure stays the message, and each note
 * names a file left behind.
 */
export class LeftBehind extends CliError {
  override readonly name: string = "LeftBehind";
  readonly failure: unknown;
  readonly notes: readonly string[];

  constructor(failure: unknown, notes: readonly string[]) {
    super(notes.join("\n"), failure instanceof CliError ? failure.exitStatus : EXIT.failure);
    this.failure = failure;
    this.notes = notes;
  }
}
