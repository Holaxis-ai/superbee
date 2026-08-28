import assert from "node:assert/strict";
import test from "node:test";

import { canonicalGeneratedText } from "../scripts/canonical-generated-text.mjs";

test("generated publication source always uses canonical LF bytes", () => {
  assert.equal(canonicalGeneratedText("one\r\ntwo\rthree\n"), "one\ntwo\nthree\n");
  assert.equal(canonicalGeneratedText("already\ncanonical\n"), "already\ncanonical\n");
});
