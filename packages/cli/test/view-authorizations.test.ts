import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViewAuthorizationSubject } from "@superbee/ui-server";
import { legacyUserStateDir, userStateDir } from "../src/user-state.js";
import { LocalViewAuthorizationStore } from "../src/ui/view-authorizations.js";

const subject: ViewAuthorizationSubject = {
  sourceKind: "registered",
  registryId: "views-registry/roadmap",
  contentVersion: "sha256:exact-html",
  contentType: "text/html; charset=utf-8",
  capability: "bundle-read",
  execution: "active",
  policyVersion: "active-view-v1",
};

test("local View approval persists only for the exact bundle, bytes, access, and policy", async () => {
  const home = await mkdtemp(join(tmpdir(), "aslite-view-auth-"));
  try {
    const approved = new LocalViewAuthorizationStore("/bundles/a", home);
    assert.equal(await approved.isAuthorized(subject), false);
    await approved.authorize(subject);
    assert.equal(
      await new LocalViewAuthorizationStore("/bundles/a", home).isAuthorized(subject),
      true,
      "a new CLI process sees the unchanged local approval",
    );
    assert.equal(
      await new LocalViewAuthorizationStore("/bundles/b", home).isAuthorized(subject),
      false,
      "approval never crosses bundle identity",
    );
    assert.equal(
      await approved.isAuthorized({ ...subject, contentVersion: "sha256:changed" }),
      false,
      "changed HTML asks again",
    );
    assert.equal(
      await approved.isAuthorized({ ...subject, capability: "bundle-propose" }),
      false,
      "expanded authority asks again",
    );

    const directory = join(userStateDir(home), "view-authorizations");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.equal((await stat(join(directory, files[0]!))).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy View approvals remain readable without making the legacy root canonical", async () => {
  const home = await mkdtemp(join(tmpdir(), "superbee-view-auth-legacy-"));
  try {
    const store = new LocalViewAuthorizationStore("/bundles/a", home);
    await store.authorize(subject);
    const canonicalDirectory = join(userStateDir(home), "view-authorizations");
    const legacyDirectory = join(legacyUserStateDir(home), "view-authorizations");
    await mkdir(legacyUserStateDir(home), { recursive: true, mode: 0o755 });
    await rename(canonicalDirectory, legacyDirectory);
    await rm(userStateDir(home), { recursive: true, force: true });
    await chmod(legacyUserStateDir(home), 0o755);

    assert.equal(await new LocalViewAuthorizationStore("/bundles/a", home).isAuthorized(subject), true);
    assert.equal((await stat(legacyUserStateDir(home))).mode & 0o777, 0o755);
    await assert.rejects(() => stat(userStateDir(home)), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
