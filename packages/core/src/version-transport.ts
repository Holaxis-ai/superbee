/** Runtime-neutral version transport primitives shared by storage adapters and HTTP clients. */

import type { Version } from "./types.js";

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
