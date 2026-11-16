/** Exit statuses of the command: 0 on success, 1 on an error, 2 on a usage error. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;
export type ExitStatus = (typeof EXIT)[keyof typeof EXIT];

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
