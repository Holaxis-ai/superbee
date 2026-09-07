import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FilesystemBackend } from "@superbee/core";
import {
  PageLaunchRegistry,
  RegisteredViewLaunchError,
  ViewNotFoundError,
  mintActiveViewLaunch,
} from "../dist/index.js";

test("an unknown registration becomes a typed View error without leaking its filesystem path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aslite-view-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = { root, backend: new FilesystemBackend(root) };

  await assert.rejects(
    mintActiveViewLaunch(bundle, new PageLaunchRegistry(), "views-registry/unknown"),
    (error) => {
      assert.ok(error instanceof ViewNotFoundError);
      assert.equal(error.code, "VIEW_NOT_FOUND");
      assert.equal(error.viewId, "views-registry/unknown");
      assert.equal(error.message, "No registered View with ID 'views-registry/unknown'.");
      assert.doesNotMatch(error.message, /ENOENT|views-registry\/unknown\.md/);
      assert.equal(error.message.includes(root), false);
      assert.ok(error.storageCause instanceof Error);
      return true;
    },
  );
});

test("launch translation does not disguise a real storage failure as an unknown View", async () => {
  const storageFailure = Object.assign(new Error("permission denied by storage"), { code: "EACCES" });
  const bundle = {
    root: "test://storage-failure",
    backend: {
      async read() {
        throw storageFailure;
      },
    },
  };

  await assert.rejects(
    mintActiveViewLaunch(bundle, new PageLaunchRegistry(), "views-registry/known"),
    (error) => {
      assert.ok(error instanceof RegisteredViewLaunchError);
      assert.equal(error.code, "VIEW_REGISTRY_READ_FAILED");
      assert.equal(error.message, "the View registration could not be read");
      assert.equal(error.message.includes(storageFailure.message), false);
      assert.equal(error.storageCause, storageFailure);
      return true;
    },
  );
});
