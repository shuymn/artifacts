/**
 * RES-2: waits are bounded where the outcome stays known. The Access key fetch, every R2 call, every D1 read and every
 * KV read of our own run under a timeout and answer 503 when it passes; the D1 commit (a write batch) has none, because
 * a commit that timed out could still apply. A timed-out call is not cancelled (the bindings take no signal); its late
 * result is ignored.
 */
export const TIMEOUTS = {
  /** jose's key set fetch, as ACC-1 states. */
  accessKeysMs: 5_000,
  /** One R2 call. A `put` carries up to the 32 MiB publish request bound, so it gets the longest wait. */
  r2Ms: 30_000,
  /** One D1 read or read batch: indexed lookups and pages of at most 100 rows. */
  d1ReadMs: 10_000,
  /** One KV read of our own: a grant's revocation record. The library's own KV calls have none of ours. */
  kvReadMs: 10_000,
} as const;

export type Timeouts = { readonly r2Ms: number; readonly d1ReadMs: number; readonly kvReadMs: number };

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
  constructor() {
    super("timed out");
  }
}

/** `work`'s result, or a TimeoutError after `ms`. The timer is cleared on every exit. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
