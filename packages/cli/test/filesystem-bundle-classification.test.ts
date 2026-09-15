import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilesystemBackend,
  MemoryBackend,
  RemoteBackend,
  type Bundle,
} from "@superbee/core";
import { isFilesystemBundle } from "../src/filesystem-runtime.js";
import {
  inBundlePollutionWarning,
  assertSafeNonDocumentOutTarget,
} from "../src/commands/egress.js";

test("filesystem egress authority follows storage identity for implicit, configured, memory and remote bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "superbee-backend-egress-"));
  const rows: { name: string; bundle: Bundle; local: boolean }[] = [
    { name: "implicit filesystem", bundle: { root }, local: true },
    {
      name: "configured filesystem",
      bundle: { root, backend: new FilesystemBackend(root) },
      local: true,
    },
    {
      name: "memory",
      bundle: { root, backend: new MemoryBackend() },
      local: false,
    },
    {
      name: "remote",
      bundle: {
        root,
        backend: new RemoteBackend({
          baseUrl: "https://example.invalid",
          bundle: "default",
        }),
      },
      local: false,
    },
  ];
  try {
    for (const { name, bundle, local } of rows) {
      assert.equal(isFilesystemBundle(bundle), local, name);
      assert.equal(
        Boolean(
          await inBundlePollutionWarning(bundle, join(root, "export.md")),
        ),
        local,
        name,
      );
      const guarded = assertSafeNonDocumentOutTarget(
        bundle,
        "--body-out",
        join(root, "body.md"),
        "body",
        "help",
      );
      if (local) await assert.rejects(guarded, /INSIDE this bundle/, name);
      else await guarded;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
