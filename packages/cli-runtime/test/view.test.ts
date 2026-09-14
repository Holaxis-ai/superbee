import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, writeBlob, writeDoc } from "@superbee/core";
import { KNOWN_COMMANDS } from "../src/cli.js";
import { view } from "../src/commands/view.js";
import { COMMAND_GROUPS } from "../src/reference.js";

test("view list is discoverable and projects the shared durable catalog", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-view-list-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "views-registry/roadmap",
      frontmatter: {
        type: "View",
        title: "Roadmap",
        entry: "views/roadmap.html",
        access: "bundle-read",
        presentation: "workspace",
      },
      body: "",
    });
    await writeBlob(
      bundle,
      "views/roadmap.html",
      new TextEncoder().encode("<!doctype html><title>Roadmap</title>"),
      "text/html; charset=utf-8",
    );
    let output = "";
    await view(["list", "--dir", dir, "--json"], {
      stdout: (text) => { output += text; },
      autoPull: async () => {},
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.views.count, 1);
    assert.equal(parsed.views.rows[0].id, "views-registry/roadmap");
    assert.equal(parsed.views.rows[0].entry, undefined);
    assert.equal(parsed.views.rows[0].presentation, "workspace");
    assert.ok(KNOWN_COMMANDS.includes("view"));
    assert.ok(COMMAND_GROUPS.flatMap((group) => group.commands).some((row) => row.usage.startsWith("view list")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
