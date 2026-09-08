/** formatWhen stays compact: never seconds; year only when it differs from now; non-dates pass through; absent is null. Locale-agnostic assertions pin shape, not exact strings. */
import { describe, expect, it, vi } from "vitest";
import { formatWhen } from "./format.js";

describe("formatWhen", () => {
  it("keeps calendar dates, local times, and invalid dates uninterpreted", () => {
    for (const value of ["2026-01-02", "2026-01-02T12:00:00", "2026-02-30T12:00:00Z", "2026-03-08T02:30:00", "2026-11-01T01:30:00"]) {
      expect(formatWhen(value, "America/New_York")).toBe(value);
    }
  });

  it("uses New York standard and daylight offsets including the spring transition", () => {
    for (const [instant, hour] of [
      ["2026-01-02T17:00:00Z", 12],
      ["2026-07-02T17:00:00Z", 13],
      ["2026-03-08T06:30:00Z", 1],
      ["2026-03-08T07:30:00Z", 3],
    ] as const) {
      const expected = new Date(instant).toLocaleString(undefined, {
        timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
      });
      expect(formatWhen(instant, "America/New_York", new Date("2026-08-01T00:00:00Z"))).toBe(expected);
      expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(instant))).toBe(String(hour).padStart(2, "0"));
    }
  });

  it("distinguishes both occurrences of the repeated fall hour and preserves explicit offsets", () => {
    const now = new Date("2026-12-01T00:00:00Z");
    const first = formatWhen("2026-11-01T05:30:00Z", "America/New_York", now);
    const second = formatWhen("2026-11-01T06:30:00Z", "America/New_York", now);
    expect(first).not.toBe(second);
    expect(formatWhen("2026-11-01T01:30:00-04:00", "America/New_York", now)).toBe(first);
    expect(formatWhen("2026-11-01T01:30:00-05:00", "America/New_York", now)).toBe(second);
  });

  it("compares years in the selected zone and leaves values raw when configuration is unavailable", () => {
    const instant = "2026-01-01T00:30:00Z";
    expect(formatWhen(instant, "America/New_York", new Date("2026-01-01T01:00:00Z"))).not.toContain("2025");
    expect(formatWhen(instant, "America/New_York", new Date("2026-01-01T06:00:00Z"))).toContain("2025");
    expect(formatWhen(instant, null)).toBe(instant);
  });
  it("absent → null; a non-date passes through verbatim", () => {
    expect(formatWhen(undefined)).toBeNull();
    expect(formatWhen("")).toBeNull();
    expect(formatWhen("not-a-date")).toBe("not-a-date");
  });

  it("never reads the host-local year and labels the default GMT zone", () => {
    const localYear = vi.spyOn(Date.prototype, "getFullYear").mockImplementation(() => { throw new Error("host local year"); });
    try {
      expect(formatWhen("2026-01-02T17:00:00Z")).toMatch(/GMT|UTC/);
    } finally {
      localYear.mockRestore();
    }
  });

  it("renders without seconds", () => {
    const out = formatWhen(new Date().toISOString())!;
    expect(out).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it("omits the year for the current year, includes it for another year", () => {
    const now = new Date();
    const sameYear = formatWhen(now.toISOString())!;
    expect(sameYear).not.toContain(String(now.getFullYear()));
    const old = formatWhen("2001-03-05T10:30:00.000Z")!;
    expect(old).toContain("2001");
  });
});
