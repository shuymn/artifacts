// The gallery's times and sizes at their unit boundaries; reference.test.ts pins the formats the reference pages show.
import { describe, expect, it } from "vitest";

import { byteSize, relativeTime, utcMinute } from "./format.ts";

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

describe("utcMinute", () => {
  it("drops seconds from the attribute and the text", () => {
    expect(utcMinute("2026-11-16T09:12:59.999Z")).toEqual({
      datetime: "2026-11-16T09:12:00Z",
      text: "2026-11-16 09:12",
    });
  });
});
