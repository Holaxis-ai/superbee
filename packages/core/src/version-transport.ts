/** Runtime-neutral version transport primitives shared by storage adapters and HTTP clients. */

import type { Version } from "./types.js";

/**
 * True only for a content-addressed {@link Version} token as every conforming backend mints it:
 * `sha256:` followed by 64 lowercase hex characters. One rule, shared by the reference router
 * (an identified delete's premise) and the View registry (an entry pin), so no adapter carries
 * its own reading of what a version looks like.
 */
export function isContentVersion(value: unknown): value is Version {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** Recover a bare version token from a quoted or weak HTTP ETag. */
export function stripETagWrapper(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("W/")) value = value.slice(2);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value;
}

/** Typed optimistic-concurrency rejection raised by every conforming backend. */
export class VersionConflict extends Error {
  override readonly name = "VersionConflict";
  readonly id: string;
  readonly expected: Version | null;
  readonly actual: Version | null;

  constructor(id: string, expected: Version | null, actual: Version | null) {
    super(
      `version conflict on '${id}': expected ${expected ?? "absent"}, found ${actual ?? "none"} ` +
        `(the document changed since you read it — re-read and retry)`,
    );
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }
}
