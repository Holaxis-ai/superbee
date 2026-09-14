// THE acquisition point for caller-supplied file content. Every command-line path whose BYTES the
// CLI ingests — `promote`, `artifact create`, and the `--body-file` flags on `doc write`,
// `doc update`, and `new` — reads through this module, so the private-state boundary is enforced BY
// THE READ rather than by a hand-kept list of guarded call sites. Two successive hand enumerations
// of that list were incomplete; this makes the guard structural, so a new ingress command cannot
// read caller-supplied content without inheriting it.
//
// Private operational state (credentials, the workspace catalog, View authorizations) must never
// become publishable bundle content, so `identical` and `inside` are refusals. Destination guarding
// for `--out` writes stays with `assertPathOutsidePrivateState` directly: a write has no bytes to
// acquire, and nothing may be written INTO private state through a caller-supplied path.
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { syncExportsRoot } from "./cursor.js";
import { assertPathOutsidePrivateState, relateToPrivateState } from "./private-state-bundle-boundary.js";

/**
 * THE one exemption, and it is not a hole: sync's CONVERGING conflict mechanic exports "yours" —
 * the local version of a conflicted BUNDLE document — into the private-state export tree, and
 * the CLI itself emits `doc update <id> --body-file <that export>` as the reconcile chain (pinned
 * character-for-character by `sync-conflict.test.ts`). Those bytes came OUT of the bundle; refusing
 * to read them back would refuse the product's own documented exit node. The exemption is
 * containment-decided by the same inode relation every other guard answers to — never a
 * prefix-string match — and an absent exports root exempts nothing.
 */
function isExportedBundleContent(resolved: string, home: string): boolean {
  return relateToPrivateState(resolved, syncExportsRoot(home)) === "bundle-inside-state";
}

/**
 * Refusals are `CliError`s, so a caller that wraps its read in a bespoke "could not read" catch must
 * re-throw `CliError` unchanged — a boundary refusal is not an I/O failure and must keep its code.
 */
function guardExternalRead(file: string, home: string = homedir()): void {
  const resolved = path.resolve(file);
  if (isExportedBundleContent(resolved, home)) return;
  assertPathOutsidePrivateState(resolved, home);
}

/** Guarded acquisition of caller-supplied UTF-8 text (Markdown bodies, promoted concept docs). */
export async function readExternalTextFile(file: string, home?: string): Promise<string> {
  guardExternalRead(file, home);
  return await fs.readFile(file, "utf8");
}

/** Guarded acquisition of caller-supplied raw bytes (blobs, artifact HTML). */
export async function readExternalFileBytes(file: string, home?: string): Promise<Buffer> {
  guardExternalRead(file, home);
  return await fs.readFile(file);
}
