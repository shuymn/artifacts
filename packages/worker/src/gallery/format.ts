/**
 * How the gallery writes times and sizes (docs/gallery/design.md, "Behavior the static design does not show"): times
 * to the minute in the request's time zone, list rows relative to now, sizes in decimal units.
 */

/**
 * The fields of a time to the minute, read from their parts, so the locale sets nothing but these options:
 * `numberingSystem` keeps the digits Latin, and `hourCycle` the hours 00 to 23.
 */
const FIELDS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  numberingSystem: "latn",
};

/**
 * The zone a page shows its times in: its IANA name as `Intl` resolves it, which each time's `title` shows and the
 * page's `ETag` covers, and the formatter of its parts.
 */
export type TimeZone = { readonly name: string; readonly format: Intl.DateTimeFormat };

const formatIn = (zone: string) => new Intl.DateTimeFormat("en-US", { ...FIELDS, timeZone: zone });

const UTC: TimeZone = { name: "UTC", format: formatIn("UTC") };

/** A zone by its IANA name, or UTC when there is none or `Intl` rejects it: a zone never fails a page. */
export function timeZone(name: string | undefined): TimeZone {
  if (name === undefined) return UTC;
  try {
    const format = formatIn(name);
    return { name: format.resolvedOptions().timeZone, format };
  } catch {
    return UTC;
  }
}

/**
 * The zone Cloudflare estimates for the request (`request.cf.timezone`, from its IP address, so a VPN or a relay gives
 * its exit's), or UTC without one.
 */
export function requestTimeZone(request: Request): TimeZone {
  const cf: unknown = request.cf;
  const name = typeof cf === "object" && cf !== null && "timezone" in cf ? cf.timezone : undefined;
  return timeZone(typeof name === "string" ? name : undefined);
}

/**
 * A time of the API's JSON (`toISOString`, so always `YYYY-MM-DDTHH:MM:SS.sssZ`) as a `<time>`'s `datetime`: its UTC
 * instant to the minute, `2026-11-16T09:12:00Z`, whatever zone the text is in.
 */
export const instant = (iso: string): string => `${iso.slice(0, 16)}:00Z`;

/** A time to the minute: its `instant`, then its date and its minute in a zone. */
export type Minute = { readonly datetime: string; readonly date: string; readonly text: string };

/** A time of the API's JSON to the minute in `zone`, `2026-11-16 18:12`, and its date by that zone's calendar. */
export function minuteIn(zone: TimeZone, iso: string): Minute {
  const datetime = instant(iso);
  const parts = zone.format.formatToParts(Date.parse(datetime));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((found) => found.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return { datetime, date, text: `${date} ${part("hour")}:${part("minute")}` };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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
