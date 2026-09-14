import test from "node:test";
import assert from "node:assert/strict";

import { looksLikeRecipePath } from "../src/recipe-ref.js";

test("recipe references recognize portable and native path spellings", () => {
  assert.equal(looksLikeRecipePath("personal-task-system"), false);
  assert.equal(looksLikeRecipePath("./recipe"), true);
  assert.equal(looksLikeRecipePath("recipes/custom"), true);
  assert.equal(looksLikeRecipePath("recipes\\custom"), true);
  assert.equal(looksLikeRecipePath("C:\\recipes\\custom"), true);
  assert.equal(looksLikeRecipePath("~/recipes/custom"), true);
});
