import test from "node:test";
import assert from "node:assert/strict";
import * as viewHostActions from "@superbee/view-host/action-bridge";
import * as viewHostPreparation from "@superbee/view-host/action-preparation";
import {
  BRIDGE_LIMITS,
  GRAPH_MAX_DOCUMENTS as HOST_GRAPH_MAX_DOCUMENTS,
  GRAPH_MAX_RELATIONSHIPS as HOST_GRAPH_MAX_RELATIONSHIPS,
  QUERY_ORDERS,
} from "@superbee/view-host/view-bridge-host";
import * as runtime from "../dist/index.js";
import * as runtimeActions from "../dist/action-bridge.js";
import * as runtimePreparation from "../dist/action-preparation.js";
import { BRIDGE_QUERY_ORDERS, GRAPH_MAX_DOCUMENTS, GRAPH_MAX_RELATIONSHIPS } from "../dist/bridge.js";

test("view-runtime's action contract paths are the View host package's, not a copy", () => {
  assert.deepEqual(Object.keys(runtimeActions).sort(), Object.keys(viewHostActions).sort());
  for (const [name, value] of Object.entries(viewHostActions)) assert.equal(runtimeActions[name], value, name);
  assert.deepEqual(Object.keys(runtimePreparation), ["prepareViewDocumentAction"]);
  assert.equal(runtimePreparation.prepareViewDocumentAction, viewHostPreparation.prepareViewDocumentAction);
  for (const name of [
    "actionError", "actionReply", "parseActionBridgeMessage", "parseDocumentAction", "parseDocumentSetFieldAction",
    "MAX_ACTION_BODY_BYTES",
  ]) assert.equal(runtime[name], viewHostActions[name], name);
  assert.equal(runtime.prepareViewDocumentAction, viewHostPreparation.prepareViewDocumentAction);
});

test("the operation-mapped host's query orders and graph ceilings equal the bridge service's", () => {
  assert.deepEqual([...QUERY_ORDERS], [...BRIDGE_QUERY_ORDERS]);
  assert.equal(HOST_GRAPH_MAX_DOCUMENTS, GRAPH_MAX_DOCUMENTS);
  assert.equal(HOST_GRAPH_MAX_RELATIONSHIPS, GRAPH_MAX_RELATIONSHIPS);
  assert.equal(BRIDGE_LIMITS.graphDocuments, GRAPH_MAX_DOCUMENTS);
  assert.equal(BRIDGE_LIMITS.graphRelationships, GRAPH_MAX_RELATIONSHIPS);
});
