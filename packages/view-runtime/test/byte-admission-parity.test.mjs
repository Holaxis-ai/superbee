import test from "node:test";
import assert from "node:assert/strict";
import * as core from "@superbee/core/view-admission";
import * as authorization from "../dist/authorization.js";
import * as runtime from "../dist/index.js";

test("local View runtime forwards the exact public byte-admission owner", () => {
  for (const name of ["admitActiveView", "MAX_ACTIVE_VIEW_BYTES", "ACTIVE_VIEW_CONTENT_TYPE"]) {
    assert.equal(authorization[name], core[name], name);
    assert.equal(runtime[name], core[name], name);
  }
  assert.equal(authorization.ACTIVE_VIEW_POLICY_VERSION, "active-view-v1");
  assert.equal("ACTIVE_VIEW_POLICY_VERSION" in core, false);
  assert.equal("SessionViewAuthorizationStore" in core, false);
});
