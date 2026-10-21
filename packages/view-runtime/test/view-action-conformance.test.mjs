import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { MemoryBackend, writeDoc, loadKinds } from "@superbee/core";
import { parseActionBridgeMessage } from "../dist/action-bridge.js";
import { prepareViewDocumentAction } from "../dist/action-preparation.js";
import { runViewActionConformance } from "./fixtures/view-action-conformance.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/view-action-conformance.json", import.meta.url), "utf8"));
for (const vector of fixture.cases) for (const edition of vector.editions ?? ["0.1", "0.2"]) {
  test(`shared View action contract: ${vector.name} (${edition})`, () => runViewActionConformance(vector, edition, fixture, {
    MemoryBackend, writeDoc, loadKinds, parseActionBridgeMessage, prepareViewDocumentAction,
  }));
}


test("portable View preparation bundles for browsers and passes the shared action vectors", async () => {
  const browser = await build({
    entryPoints: [fileURLToPath(new URL("../dist/action-preparation.js", import.meta.url))],
    bundle: true, platform: "browser", format: "iife", globalName: "ViewPreparation",
    write: false, logLevel: "silent", metafile: true,
  });
  assert.ok(Object.values(browser.metafile.outputs).every(output => output.imports.length === 0));
  const sandbox = { TextEncoder, TextDecoder, structuredClone };
  for (const name of ["process", "Buffer", "require"]) assert.equal(runInNewContext(`typeof ${name}`, sandbox), "undefined");
  runInNewContext(browser.outputFiles[0].text, sandbox);
  for (const vector of fixture.cases) for (const edition of vector.editions ?? ["0.1", "0.2"]) {
    await runViewActionConformance(vector, edition, fixture, {
      MemoryBackend, writeDoc, loadKinds, parseActionBridgeMessage,
      prepareViewDocumentAction: (doc, action, context) => {
        // Browser messages are decoded in their receiving realm, as the action parser requires.
        sandbox.input = { doc: JSON.stringify(doc), action: JSON.stringify(action), context };
        return runInNewContext("ViewPreparation.prepareViewDocumentAction(JSON.parse(input.doc), JSON.parse(input.action), input.context)", sandbox);
      },
    });
  }
});
