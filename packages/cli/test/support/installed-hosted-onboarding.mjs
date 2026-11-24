import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { decode } from "@toon-format/toon";
import { FakeIssuer } from "./fake-issuer.ts";
import { startFakeHostBridge } from "./fake-host-bridge.ts";
import { BUNDLE, FakeHost } from "./fake-hosted-sync.ts";
export { protectWindowsAuthRecord } from "../../src/hosted-auth/auth-record.ts";

/** Use the existing loopback issuer and stateful sync fixtures through the installed CLI. */
export async function proveInstalledHostedOnboarding({ folder, stateRoot, cli, credentialStore = "windows-dpapi" }) {
  const issuer = await new FakeIssuer({ accessTokenTtlSeconds: 60 }).start();
  let bridge;
  try {
    let host;
    bridge = await startFakeHostBridge(() => ({
      origin: host.origin,
      fetch: (url, options) => {
        const headers = new Headers(options.headers);
        assert.ok(issuer.lastAccessToken);
        assert.equal(headers.get("authorization"), `Bearer ${issuer.lastAccessToken}`);
        headers.set("authorization", `Bearer ${host.token}`);
        return host.fetch(url, { ...options, headers });
      },
    }), { others: () => issuer.base });
    host = new FakeHost({ origin: bridge.url });
    issuer.prmOverride.resource = `${bridge.url}/mcp`;
    host.put("notes/windows", { type: "Note", title: "Before Windows edit" }, "A fixture document.\n");

    const login = ["login", "--host", bridge.url];
    const pending = decode((await cli(login, 4)).stdout).error;
    assert.equal(pending.code, "AUTH_REQUIRED");
    assert.match(pending.details.sign_in_url, /^http:\/\/127\.0\.0\.1:/u);
    const account = `${bridge.url} ${bridge.url}/mcp`;
    const accountKey = createHash("sha256").update(account).digest("hex").slice(0, 32);
    const authDirectory = path.join(stateRoot, "hosted-auth", accountKey);
    const pendingBytes = await readFile(path.join(authDirectory, "pending.json"), "utf8");
    if (credentialStore === "windows-dpapi") {
      assert.match(pendingBytes, /^dpapi-v1:/u);
      for (const code of issuer.devices.keys()) assert.ok(!pendingBytes.includes(code));
    }
    issuer.approve();
    // Use the production resumable device flow and honor the issuer's poll interval.
    await setTimeout(1_100);
    const signedIn = JSON.parse((await cli([...login, "--json"])).stdout);
    assert.equal(signedIn.status, "signed_in");
    assert.equal(signedIn.credential_store, credentialStore);
    assert.equal(issuer.counts.deviceCode, 1);
    assert.equal(issuer.counts.devicePoll, 1);

    const tokenFile = path.join(authDirectory, credentialStore === "windows-dpapi" ? "refresh-token.dpapi" : "refresh-token.json");
    const stored = await readFile(tokenFile, "utf8");
    if (credentialStore === "windows-dpapi") {
      assert.match(stored.trim(), /^[A-Za-z0-9+/]+=*$/u);
      for (const secret of issuer.refreshTokens.keys()) {
        assert.ok(!stored.includes(secret));
        assert.ok(!Buffer.from(stored, "base64").includes(Buffer.from(secret)));
      }
      const sessionFile = path.join(authDirectory, "session.json");
      const sessionBytes = await readFile(sessionFile, "utf8");
      assert.match(sessionBytes, /^dpapi-v1:/u);
      assert.ok(!sessionBytes.includes(issuer.lastAccessToken));
      await writeFile(sessionFile, pendingBytes);
      const wrongRecord = decode((await cli(["whoami", "--host", bridge.url], 1)).stdout).error;
      assert.equal(wrongRecord.code, "CREDENTIAL_STORE_UNAVAILABLE");
      await writeFile(sessionFile, sessionBytes);
    }

    const checkout = JSON.parse((await cli(["checkout", BUNDLE, "--dir", folder, "--json"])).stdout);
    assert.equal(checkout.checkout, "created");
    assert.ok(issuer.counts.refresh > 0, "a second process must renew the expiring access token");
    assert.notEqual(await readFile(tokenFile, "utf8"), stored, "refresh must replace the saved secret");
    const edit = ["doc", "read", "notes/windows", "--dir", folder, "--json"];
    const listed = JSON.parse((await cli(["list", "--dir", folder, "--json"])).stdout);
    assert.ok(listed.docs.some((entry) => entry.id === "notes/windows"));
    const doc = JSON.parse((await cli(edit)).stdout);
    assert.equal(doc.title, "Before Windows edit");
    const title = "Confirmed Windows edit";
    const result = JSON.parse((await cli([
      "doc", "update", "notes/windows", "--dir", folder, "--expected-version", doc.head_version,
      "--title", title, "--actor", "process:windows-proof", "--json",
    ])).stdout);
    assert.equal(result.changed, true);
    await cli(["sync", "--dir", folder, "--json"]);
    assert.equal(host.docs.get("notes/windows").frontmatter.title, title);
    assert.deepEqual(host.applied, ["notes/windows"]);

    const signedOut = JSON.parse((await cli(["logout", "--json"])).stdout);
    assert.equal(signedOut.revoked, true);
    assert.equal(issuer.counts.revoke, 1);
    await assert.rejects(lstat(tokenFile), { code: "ENOENT" });
  } finally {
    await bridge?.close();
    await issuer.stop();
  }
}
