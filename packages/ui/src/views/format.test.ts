/** formatWhen stays compact: never seconds; year only when it differs from now; non-dates pass through; absent is null. Locale-agnostic assertions pin shape, not exact strings. */
import { describe, expect, it } from "vitest";
import { formatWhen } from "./format.js";

describe("formatWhen", () => {
  it("absent → null; a non-date passes through verbatim", () => {
    expect(formatWhen(undefined)).toBeNull();
    expect(formatWhen("")).toBeNull();
    expect(formatWhen("not-a-date")).toBe("not-a-date");
  });

  it("renders without seconds", () => {
    const out = formatWhen(new Date().toISOString())!;
    expect(out).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it.each(["2026-09-08", "2026-09-08T12:30:00", "2026-02-30T12:30:00Z"])("keeps ambiguous or invalid imported timestamp %s literal", (value) => {
    expect(formatWhen(value)).toBe(value);
  });

  it.each(["Z", "+05:30", "-0700", "+02"])("renders explicit offset %s in the system timezone", (offset) => {
    const timestamp = `2001-03-05T10:30:00${offset}`;
    const normalized = offset === "+02" ? timestamp + ":00" : timestamp;
    const expected = new Date(normalized).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
    expect(formatWhen(timestamp)).toBe(expected);
  });

  it("omits the year for the current year, includes it for another year", () => {
    const now = new Date();
    const sameYear = formatWhen(now.toISOString())!;
    expect(sameYear).not.toContain(String(now.getFullYear()));
    const old = formatWhen("2001-03-05T10:30:00.000Z")!;
    expect(old).toContain("2001");
  });
});
