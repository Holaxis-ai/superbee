/**
 * `credentials.ts` — the origin-keyed `remotes` map (Stage-1 Unit 2b Part C) is now the SOLE
 * credential shape: a file is valid (non-null) iff it carries at least one `remotes` entry. (The
 * legacy `server`/`access_token` bearer fields were removed.)
 *
 * Uses REAL disk I/O against an isolated temp `home` dir (the injectable param every function in
 * this module already accepts) — no mocking of `os.homedir()`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadCredentials,
  saveCredentials,
  getApiKeyForOrigin,
  saveApiKeyForOrigin,
  credentialsPath,
  legacyCredentialsPath,
} from "../src/credentials.js";

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-creds-test-"));
}

test("saveApiKeyForOrigin / getApiKeyForOrigin: round-trip on a fresh (no prior file) home dir", async () => {
  const home = await tempHome();
  try {
    assert.equal(await getApiKeyForOrigin("https://worker.example", home), undefined);

    await saveApiKeyForOrigin("https://worker.example", "secret-key", home);
    assert.equal(await getApiKeyForOrigin("https://worker.example", home), "secret-key");
    assert.equal(await getApiKeyForOrigin("https://other.example", home), undefined, "keys are origin-scoped");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("saveApiKeyForOrigin: a SECOND origin's key does not clobber the first — origin-keyed from birth, not a single slot", async () => {
  const home = await tempHome();
  try {
    await saveApiKeyForOrigin("https://staging.example", "staging-key", home);
    await saveApiKeyForOrigin("https://prod.example", "prod-key", home);

    assert.equal(await getApiKeyForOrigin("https://staging.example", home), "staging-key");
    assert.equal(await getApiKeyForOrigin("https://prod.example", home), "prod-key");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loadCredentials: a file with a remotes map loads as valid (non-null)", async () => {
  const home = await tempHome();
  try {
    await saveApiKeyForOrigin("https://worker.example", "k", home);
    const creds = await loadCredentials(home);
    assert.ok(creds, "a remotes file must load as valid credentials");
    assert.equal(creds!.remotes?.["https://worker.example"]?.api_key, "k");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loadCredentials: a file with no remotes entry is null (unusable)", async () => {
  const home = await tempHome();
  try {
    // An empty credentials object has nothing usable.
    await saveCredentials({}, home);
    assert.equal(await loadCredentials(home), null);

    // An EMPTY remotes object is also treated as "nothing usable here."
    await saveCredentials({ remotes: {} }, home);
    assert.equal(await loadCredentials(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("saveApiKeyForOrigin: the on-disk file keeps 0600 perms (same atomic write path as saveCredentials)", async () => {
  const home = await tempHome();
  try {
    await saveApiKeyForOrigin("https://worker.example", "k", home);
    const stat = await import("node:fs/promises").then((fs) => fs.stat(credentialsPath(home)));
    assert.equal(stat.mode & 0o777, 0o600);
    // Sanity: the file is real, valid JSON, and the key value is present in it.
    const raw = await readFile(credentialsPath(home), "utf8");
    assert.match(raw, /"k"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy credentials are read without mutating their root and migrate on the next canonical write", async () => {
  const home = await tempHome();
  try {
    const legacyPath = legacyCredentialsPath(home);
    await mkdir(path.dirname(legacyPath), { recursive: true, mode: 0o755 });
    await writeFile(
      legacyPath,
      JSON.stringify({ remotes: { "https://legacy.example": { api_key: "legacy-key" } } }) + "\n",
      { mode: 0o600 },
    );
    await chmod(path.dirname(legacyPath), 0o755);
    const legacyBytes = await readFile(legacyPath, "utf8");

    assert.equal(await getApiKeyForOrigin("https://legacy.example", home), "legacy-key");
    assert.equal((await stat(path.dirname(legacyPath))).mode & 0o777, 0o755, "fallback reads never chmod the legacy root");
    await assert.rejects(() => stat(credentialsPath(home)), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    await saveApiKeyForOrigin("https://new.example", "new-key", home);
    assert.equal(await getApiKeyForOrigin("https://legacy.example", home), "legacy-key");
    assert.equal(await getApiKeyForOrigin("https://new.example", home), "new-key");
    assert.equal((await stat(path.dirname(credentialsPath(home)))).mode & 0o777, 0o700);
    assert.equal(await readFile(legacyPath, "utf8"), legacyBytes, "migration never rewrites the legacy source");
    assert.equal((await stat(path.dirname(legacyPath))).mode & 0o777, 0o755);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("canonical credentials win over a conflicting legacy record", async () => {
  const home = await tempHome();
  try {
    await mkdir(path.dirname(legacyCredentialsPath(home)), { recursive: true });
    await writeFile(
      legacyCredentialsPath(home),
      JSON.stringify({ remotes: { "https://worker.example": { api_key: "legacy" } } }) + "\n",
    );
    await saveCredentials({ remotes: { "https://worker.example": { api_key: "canonical" } } }, home);
    assert.equal(await getApiKeyForOrigin("https://worker.example", home), "canonical");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
