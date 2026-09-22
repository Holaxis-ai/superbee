import test from "node:test";
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
