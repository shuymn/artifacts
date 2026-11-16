/**
 * How the gallery writes times and sizes (docs/gallery/design.md, "Behavior the static design does not show"): times
 * in UTC to the minute, list rows relative to now, sizes in decimal units.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A time of the API's JSON (`toISOString`, so always `YYYY-MM-DDTHH:MM:SS.sssZ`) to the minute. */
export function utcMinute(iso: string): { readonly datetime: string; readonly text: string } {
  return { datetime: `${iso.slice(0, 16)}:00Z`, text: `${iso.slice(0, 10)} ${iso.slice(11, 16)}` };
}

const ago = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;

/**
 * How long before `now` a time was, rounded to its largest unit: `just now`, minutes, hours, `yesterday`, days for the
 * first 60, then months of 30 days, then years. A time after `now` (a clock behind the stored one) is `just now`.
 */
export function relativeTime(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (elapsed < MINUTE_MS) return "just now";
  const minutes = Math.round(elapsed / MINUTE_MS);
  if (minutes < 60) return ago(minutes, "minute");
  const hours = Math.round(elapsed / HOUR_MS);
  if (hours < 24) return ago(hours, "hour");
  const days = Math.max(1, Math.round(elapsed / DAY_MS));
  if (days === 1) return "yesterday";
  if (days < 60) return ago(days, "day");
  if (days < 365) return ago(Math.round(days / 30), "month");
  return ago(Math.round(days / 365), "year");
}

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** A byte count in decimal units with one decimal (`48.2 KB`); under 1000, in bytes (`512 B`). */
export function byteSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes / 1000;
  for (const [index, unit] of UNITS.entries()) {
    // Rounding to one decimal can reach 1000 (999.96 KB); that is the next unit's 1.0.
    if (Number(value.toFixed(1)) < 1000 || index === UNITS.length - 1) return `${value.toFixed(1)} ${unit}`;
    value /= 1000;
  }
  return `${bytes} B`;
}
