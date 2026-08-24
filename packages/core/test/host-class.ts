/**
 * Filesystem host-class detection shared by the native identity proofs. A host is "aliasing"
 * when a differently spelled name resolves to an existing entry while the entry keeps its
 * written spelling (case-insensitive APFS, NTFS, ext4 casefold); "normalizing" when the store
 * rewrites names on write (legacy HFS+); otherwise "exact".
 *
 * `SUPERBEE_TEST_EXPECT_ALIASING_HOST=1|0` pins what a CI lane claims its host is: the detected
 * class must agree or the proof fails closed. Read by test files only, never by runtime source.
 */
import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type HostClass = "aliasing" | "exact" | "normalizing";

const NFC_PROBE = "café-probe";

export async function detectHostClassIn(dir: string): Promise<HostClass> {
  await writeFile(path.join(dir, "probe-name"), "probe");
  await writeFile(path.join(dir, NFC_PROBE), "probe");
  const listed = await readdir(dir);
  if (!listed.includes(NFC_PROBE)) return "normalizing";
  try {
    await lstat(path.join(dir, "PROBE-NAME"));
    return "aliasing";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "exact";
    throw err;
  }
}

/** Detect in a fresh temp directory, then hold the lane's expectation to account. */
export async function detectHostClass(): Promise<HostClass> {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-host-class-"));
  try {
    const detected = await detectHostClassIn(dir);
    assertHostClassExpectation(detected);
    return detected;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function assertHostClassExpectation(detected: HostClass): void {
  const expectation = process.env.SUPERBEE_TEST_EXPECT_ALIASING_HOST;
  if (expectation === undefined || expectation === "") return;
  assert.ok(expectation === "1" || expectation === "0", `SUPERBEE_TEST_EXPECT_ALIASING_HOST must be 1 or 0, got '${expectation}'`);
  const expected: HostClass = expectation === "1" ? "aliasing" : "exact";
  assert.equal(detected, expected, `this lane expects a ${expected} host but the filesystem is ${detected}`);
}
