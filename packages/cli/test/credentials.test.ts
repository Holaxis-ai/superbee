/**
 * `credentials.ts` — schema 2's exact origin-and-bundle `remotes` map is the sole credential
 * shape: a file is valid (non-null) iff it carries at least one `remotes` entry. (The
 * legacy `server`/`access_token` bearer fields were removed.)
 *
 * Uses REAL disk I/O against an isolated temp `home` dir (the injectable param every function in
 * this module already accepts) — no mocking of `os.homedir()`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadCredentials,
  saveCredentials,
  getApiKeyForRemote,
  saveApiKeyForRemote,
  credentialsPath,
} from "../src/credentials.js";

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-creds-test-"));
}

const A = "bnd_11111111111111111111111111111111";
const B = "bnd_22222222222222222222222222222222";

test("saveApiKeyForRemote / getApiKeyForRemote: round-trip on a fresh home dir", async () => {
  const home = await tempHome();
  try {
    assert.equal(await getApiKeyForRemote("https://worker.example", A, home), undefined);

    await saveApiKeyForRemote("https://worker.example", A, "secret-key", home);
    assert.equal(await getApiKeyForRemote("https://worker.example", A, home), "secret-key");
    assert.equal(await getApiKeyForRemote("https://worker.example", B, home), undefined, "keys are bundle-scoped");
    assert.equal(await getApiKeyForRemote("https://other.example", A, home), undefined, "keys are origin-scoped");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("saveApiKeyForRemote merges origins and bundles without clobbering", async () => {
  const home = await tempHome();
  try {
    await saveApiKeyForRemote("https://staging.example", A, "staging-a", home);
    await saveApiKeyForRemote("https://staging.example", B, "staging-b", home);
    await saveApiKeyForRemote("https://prod.example", A, "prod-key", home);

    assert.equal(await getApiKeyForRemote("https://staging.example", A, home), "staging-a");
    assert.equal(await getApiKeyForRemote("https://staging.example", B, home), "staging-b");
    assert.equal(await getApiKeyForRemote("https://prod.example", A, home), "prod-key");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loadCredentials: a file with a remotes map loads as valid (non-null)", async () => {
  const home = await tempHome();
  try {
    await saveApiKeyForRemote("https://worker.example", A, "k", home);
    const creds = await loadCredentials(home);
    assert.ok(creds, "a remotes file must load as valid credentials");
    assert.equal(creds!.schema, 2);
    assert.equal(creds!.remotes["https://worker.example"]?.bundles[A]?.api_key, "k");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loadCredentials: a file with no remotes entry is null (unusable)", async () => {
  const home = await tempHome();
  try {
    // An empty credentials object has nothing usable.
    await saveCredentials({ schema: 2, remotes: {} }, home);
    assert.equal(await loadCredentials(home), null);

    // An EMPTY remotes object is also treated as "nothing usable here."
    await saveCredentials({ schema: 2, remotes: {} }, home);
    assert.equal(await loadCredentials(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loadCredentials refuses origin-only v1 credentials instead of silently widening them to every bundle", async () => {
  const home = await tempHome();
  try {
    await saveApiKeyForRemote("https://worker.example", A, "temporary-current-key", home);
    await writeFile(
      credentialsPath(home),
      `${JSON.stringify({ remotes: { "https://worker.example": { api_key: "legacy-origin-wide-key" } } })}\n`,
      { mode: 0o600 },
    );
    assert.equal(await loadCredentials(home), null);
    assert.equal(await getApiKeyForRemote("https://worker.example", A, home), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("saveApiKeyForRemote: the on-disk file keeps 0600 perms", async () => {
  const home = await tempHome();
  try {
    await saveApiKeyForRemote("https://worker.example", A, "k", home);
    const stat = await import("node:fs/promises").then((fs) => fs.stat(credentialsPath(home)));
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
    // Sanity: the file is real, valid JSON, and the key value is present in it.
    const raw = await readFile(credentialsPath(home), "utf8");
    assert.match(raw, /"k"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
