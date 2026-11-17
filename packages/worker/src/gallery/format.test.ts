// The gallery's times and sizes at their unit boundaries, and times in the request's zone; reference.test.ts pins the
// formats the reference pages show.
import { describe, expect, it } from "vitest";

import { byteSize, minuteIn, relativeTime, requestTimeZone, timeZone } from "./format.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const before = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it.each([
    [-5 * MINUTE, "just now"],
    [59_999, "just now"],
    [MINUTE, "1 minute ago"],
    [59 * MINUTE, "59 minutes ago"],
    [59.5 * MINUTE, "1 hour ago"],
    [23 * HOUR, "23 hours ago"],
    [23.5 * HOUR, "yesterday"],
    [36 * HOUR, "2 days ago"],
    [59 * DAY, "59 days ago"],
    [60 * DAY, "2 months ago"],
    [364 * DAY, "12 months ago"],
    [365 * DAY, "1 year ago"],
    [800 * DAY, "2 years ago"],
  ])("writes %d ms before now as %s", (ms, text) => {
    expect(relativeTime(before(ms), NOW)).toBe(text);
  });
});

describe("byteSize", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1000, "1.0 KB"],
    [48_213, "48.2 KB"],
    [999_949, "999.9 KB"],
    [999_950, "1.0 MB"],
    [2_000_000_000, "2.0 GB"],
  ])("writes %d bytes as %s", (bytes, text) => {
    expect(byteSize(bytes)).toBe(text);
  });
});

describe("minuteIn", () => {
  it("drops seconds from the attribute and the text", () => {
    expect(minuteIn(timeZone("UTC"), "2026-11-16T09:12:59.999Z")).toEqual({
      datetime: "2026-11-16T09:12:00Z",
      date: "2026-11-16",
      text: "2026-11-16 09:12",
    });
  });

  // The instant stays UTC; the text and the date are the zone's, which can be another day than UTC's.
  it.each([
    ["Asia/Tokyo", "2026-11-16T09:12:00.000Z", "2026-11-16", "2026-11-16 18:12"],
    ["Asia/Tokyo", "2026-11-15T21:03:00.000Z", "2026-11-16", "2026-11-16 06:03"],
    ["Asia/Tokyo", "2026-11-15T15:00:00.000Z", "2026-11-16", "2026-11-16 00:00"],
    ["America/Los_Angeles", "2026-11-16T05:30:00.000Z", "2026-11-15", "2026-11-15 21:30"],
    // Daylight saving time ends on 2026-11-01 at 09:00 UTC (02:00 PDT): the same UTC hour reads an hour earlier.
    ["America/Los_Angeles", "2026-10-31T20:00:00.000Z", "2026-10-31", "2026-10-31 13:00"],
    ["America/Los_Angeles", "2026-11-01T20:00:00.000Z", "2026-11-01", "2026-11-01 12:00"],
    // It starts on 2026-03-08 at 10:00 UTC (02:00 PST), so 01:59 is followed by 03:00.
    ["America/Los_Angeles", "2026-03-08T09:59:00.000Z", "2026-03-08", "2026-03-08 01:59"],
    ["America/Los_Angeles", "2026-03-08T10:00:00.000Z", "2026-03-08", "2026-03-08 03:00"],
  ])("writes a time in %s: %s as %s, %s", (zone, iso, date, text) => {
    expect(minuteIn(timeZone(zone), iso)).toEqual({ datetime: `${iso.slice(0, 16)}:00Z`, date, text });
  });
});

describe("timeZone", () => {
  // The name is the one Intl resolves, which titles every time and enters the page's tag; what Intl rejects is UTC.
  it.each([
    ["Asia/Tokyo", "Asia/Tokyo", "2026-11-16 18:12"],
    ["america/los_angeles", "America/Los_Angeles", "2026-11-16 01:12"],
    ["UTC", "UTC", "2026-11-16 09:12"],
    [undefined, "UTC", "2026-11-16 09:12"],
    ["", "UTC", "2026-11-16 09:12"],
    ["Not/AZone", "UTC", "2026-11-16 09:12"],
    ["Asia/Tokyo\nX", "UTC", "2026-11-16 09:12"],
  ])("resolves %j to %s", (name, resolved, text) => {
    const zone = timeZone(name);
    expect(zone.name).toBe(resolved);
    expect(minuteIn(zone, "2026-11-16T09:12:00.000Z").text).toBe(text);
  });

  it.each([
    ["a zone", { timezone: "Asia/Tokyo" }, "Asia/Tokyo"],
    ["no cf", undefined, "UTC"],
    ["cf without a zone", { country: "JP" }, "UTC"],
    ["a zone that is not a string", { timezone: 9 }, "UTC"],
    ["a zone Intl rejects", { timezone: "Mars/Olympus_Mons" }, "UTC"],
  ])("takes the request's zone from request.cf: %s", (_case, cf, name) => {
    const request = new Request("https://artifacts.example.com/", cf === undefined ? {} : { cf });
    expect(requestTimeZone(request).name).toBe(name);
  });
});
