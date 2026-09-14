import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViewAuthorizationSubject } from "@superbee/ui-server";
import { credentialsDir } from "../src/credentials.js";
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

    const directory = join(credentialsDir(home), "view-authorizations");
    if (process.platform !== "win32") assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    if (process.platform !== "win32") assert.equal((await stat(join(directory, files[0]!))).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("View approval reads and writes both reject an unsafe containing directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "superbee-view-auth-container-"));
  try {
    const store = new LocalViewAuthorizationStore("/bundles/a", home);
    await store.authorize(subject);
    const directory = join(credentialsDir(home), "view-authorizations");
    const external = join(home, "external-authorizations");
    await rename(directory, external);
    await chmod(external, 0o777);
    await symlink(external, directory, "dir");

    await assert.rejects(
      store.isAuthorized(subject),
      /unsafe containing directory/,
      "a valid approval file cannot gain trust through a symlinked public container",
    );
    await assert.rejects(store.authorize(subject), /private user-state path is not a real directory/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
