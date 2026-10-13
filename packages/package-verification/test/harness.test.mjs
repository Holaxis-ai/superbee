import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertArtifact, assertIdentity, assertIntegrity, createWorkspace, isolatedEnvironment, runProcess, runProcessSync } from "../src/harness.mjs";

test("closed environment, denied network and bounded output fail without inherited secrets", async () => {
  const workspace = await createWorkspace();
  try {
    const env = isolatedEnvironment({ home: workspace.root });
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NODE_AUTH_TOKEN, undefined);
    assert.throws(() => isolatedEnvironment({ home: workspace.root, values: { NODE_OPTIONS: "injection" } }));
    const preload = fileURLToPath(new URL("../src/no-network.mjs", import.meta.url));
    const code = `import assert from 'node:assert/strict'; import net from 'node:net'; import https from 'node:https'; await assert.rejects(fetch('https://example.invalid'), /Network refused/); assert.throws(()=>net.connect(443,'example.invalid'), /Network refused/); assert.throws(()=>https.request('https://example.invalid'), /Network refused/); console.log(process.env.NODE_AUTH_TOKEN ?? 'closed');`;
    const result = await runProcess(process.execPath, ["--import", preload, "--input-type=module", "-e", code], { cwd: workspace.root, env });
    assert.equal(result.stdout.trim(), "closed");
    await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(0)"], { cwd: workspace.root, env, expected: 2 }));
    assert.equal(runProcessSync(process.execPath, ["-e", "console.log('refused');process.exit(2)"], { cwd: workspace.root, env, expected: 2 }).stdout.trim(), "refused");
    await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: workspace.root, env, timeout: 50 }), /Isolated package subprocess/);
    assert.throws(() => runProcessSync(process.execPath, ["-e", "console.log('x'.repeat(5000))"], { cwd: workspace.root, env, maxBuffer: 20 }), /Isolated package subprocess/);
  } finally { await workspace.close(); }
  await assert.rejects(access(workspace.root), { code: "ENOENT" });
});

test("exact integrity and identity reject drift", async () => {
  const bytes = Buffer.from("retained bytes"), sha = createHash("sha256").update(bytes).digest("hex");
  assertIntegrity(bytes, `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  assert.throws(() => assertIntegrity(Buffer.from("changed"), `sha256-${Buffer.from(sha,"hex").toString("base64")}`));
  assertIdentity({ package: { name: "fixture", version: "1.0.0" } }, { package: { name: "fixture" } });
  assert.throws(() => assertIdentity({ source: { dirty: true } }, { source: { dirty: false } }));
  const workspace = await createWorkspace();
  try { const file = `${workspace.root}/artifact`; await writeFile(file, bytes); await assertArtifact(file, `sha256:${sha}`); await assert.rejects(assertArtifact(file, `sha256:${"0".repeat(64)}`)); }
  finally { await workspace.close(); }
});
