/**
 * `bundle.ts` — the project-binding resolution rung (item 43 follow-on): a committed
 * `.agentstate.json` (`{ "bundle": "<path>" }`) discovered by walking up from the cwd.
 *
 * Covers local-path resolution, URL rejection, the retired env migration error, explicit flag
 * precedence, and end-to-end proof that a bare command never activates HTTP.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc } from "@superbee/core";

import {
  resolveProjectBinding,
  resolveRemoteFlag,
  openBundle,
  PROJECT_BINDING_FILE_NAME,
  SUPERBEE_PROJECT_BINDING_FILE_NAME,
  CONVENTIONAL_BUNDLE_DIR_NAME,
  LEGACY_CONVENTIONAL_BUNDLE_DIR_NAME,
} from "../src/bundle.js";
import { CliError } from "../src/errors.js";
import { list } from "../src/commands/list.js";

// Realpath'd (not just mkdtemp'd): on macOS, `os.tmpdir()` lands under `/var/folders/...`, a
// symlink to `/private/var/folders/...` — `process.chdir()` + `process.cwd()` resolve THROUGH it,
// so a raw (un-resolved) temp path would never string-compare equal to what `resolveProjectBinding`/
// `openBundle` derive from `process.cwd()`. Resolving once here keeps every downstream `path.join`
// consistent with that.
async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "agentstate-lite-bundle-test-")));
}

async function writeBinding(
  dir: string,
  bundle: unknown,
  filename: string = PROJECT_BINDING_FILE_NAME,
): Promise<void> {
  await writeFile(path.join(dir, filename), JSON.stringify({ bundle }));
}

async function writeRawBinding(
  dir: string,
  raw: string,
  filename: string = PROJECT_BINDING_FILE_NAME,
): Promise<void> {
  await writeFile(path.join(dir, filename), raw);
}

/** Run inside `dir` (chdir + restore), even if `fn` throws. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(orig);
  }
}

// ── resolveProjectBinding: discovery + parsing ──────────────────────────────

test("resolveProjectBinding: null when no .agentstate.json exists anywhere up-tree", async () => {
  const dir = await tempDir();
  try {
    await inDir(dir, async () => {
      assert.equal(await resolveProjectBinding(), null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectBinding: finds a binding in the cwd itself; a relative path resolves against the FILE's own directory, not the cwd", async () => {
  const root = await tempDir();
  try {
    const sharedBundle = path.join(root, "shared-bundle");
    await initBundle(sharedBundle);
    const projectDir = path.join(root, "project");
    await mkdir(projectDir, { recursive: true });
    await writeBinding(projectDir, "../shared-bundle");

    await inDir(projectDir, async () => {
      const binding = await resolveProjectBinding();
      assert.ok(binding);
      assert.equal(binding!.file, path.join(projectDir, PROJECT_BINDING_FILE_NAME));
      // Resolved against the BINDING FILE's directory (projectDir), which is where "../shared-bundle"
      // actually lands — NOT wherever the cwd happens to be when a NESTED cwd is used (see the next
      // test), and not some other unrelated interpretation.
      assert.equal(binding!.target, path.resolve(sharedBundle));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectBinding: the preferred .superbee.json binding resolves through the same parser", async () => {
  const root = await tempDir();
  try {
    const project = path.join(root, "project");
    await mkdir(project);
    await writeBinding(project, "../shared", SUPERBEE_PROJECT_BINDING_FILE_NAME);

    const binding = await resolveProjectBinding(project);
    assert.deepEqual(binding, {
      file: path.join(project, SUPERBEE_PROJECT_BINDING_FILE_NAME),
      target: path.join(root, "shared"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectBinding: walk-up discovery from a nested cwd — the NEAREST ancestor's binding wins, not a further one", async () => {
  const root = await tempDir();
  try {
    await writeBinding(root, "../far");
    const mid = path.join(root, "mid");
    await mkdir(mid, { recursive: true });
    await writeBinding(mid, "../near");
    const deep = path.join(mid, "deep", "deeper");
    await mkdir(deep, { recursive: true }); // no binding file directly here — must walk up

    await inDir(deep, async () => {
      const binding = await resolveProjectBinding();
      assert.ok(binding);
      assert.equal(binding!.file, path.join(mid, PROJECT_BINDING_FILE_NAME));
      assert.equal(binding!.target, path.resolve(mid, "../near"));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectBinding: nearest level wins across old and new names in either direction", async (t) => {
  for (const [nearName, farName] of [
    [SUPERBEE_PROJECT_BINDING_FILE_NAME, PROJECT_BINDING_FILE_NAME],
    [PROJECT_BINDING_FILE_NAME, SUPERBEE_PROJECT_BINDING_FILE_NAME],
  ] as const) {
    await t.test(`${nearName} over ${farName}`, async () => {
      const root = await tempDir();
      try {
        await writeBinding(root, "far", farName);
        const near = path.join(root, "near");
        const nested = path.join(near, "nested");
        await mkdir(nested, { recursive: true });
        await writeBinding(near, "near-target", nearName);

        assert.deepEqual(await resolveProjectBinding(nested), {
          file: path.join(near, nearName),
          target: path.join(near, "near-target"),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("resolveProjectBinding: both names at the same level fail closed even when targets match", async () => {
  const root = await tempDir();
  try {
    await writeBinding(root, "shared", SUPERBEE_PROJECT_BINDING_FILE_NAME);
    await writeBinding(root, "shared", PROJECT_BINDING_FILE_NAME);

    await assert.rejects(() => resolveProjectBinding(root), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "USAGE");
      assert.match(err.message, /conflicting project bindings/);
      assert.ok(err.message.includes(path.join(root, SUPERBEE_PROJECT_BINDING_FILE_NAME)));
      assert.ok(err.message.includes(path.join(root, PROJECT_BINDING_FILE_NAME)));
      assert.match(err.help ?? "", /--dir/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectBinding: a malformed nearer binding blocks a valid farther binding across names", async () => {
  const root = await tempDir();
  try {
    await writeBinding(root, "far", PROJECT_BINDING_FILE_NAME);
    const near = path.join(root, "near");
    const nested = path.join(near, "nested");
    await mkdir(nested, { recursive: true });
    await writeRawBinding(near, "{not json", SUPERBEE_PROJECT_BINDING_FILE_NAME);

    await assert.rejects(() => resolveProjectBinding(nested), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "USAGE");
      assert.ok(err.message.includes(path.join(near, SUPERBEE_PROJECT_BINDING_FILE_NAME)));
      assert.ok(!err.message.includes(path.join(root, PROJECT_BINDING_FILE_NAME)));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectBinding: valid, malformed, unsupported, and protocol-relative URI shapes are rejected as URI intent", async () => {
  const dir = await tempDir();
  try {
    const cases = [
      { value: "http://127.0.0.1:9999", detail: /remote URL/ },
      { value: "https://worker.example.workers.dev", detail: /remote URL/ },
      { value: "http://", detail: /invalid http URL/ },
      { value: "https://", detail: /invalid https URL/ },
      { value: "http://[::1", detail: /invalid http URL/ },
      { value: "ftp://files.example", detail: /unsupported URI scheme "ftp"/ },
      { value: "x://remote.example/bundle", detail: /unsupported URI scheme "x"/ },
      { value: "C://remote.example/bundle", detail: /unsupported URI scheme "c"/ },
      { value: "//example.com/bundle", detail: /protocol-relative URL/ },
    ];
    for (const { value, detail } of cases) {
      await writeBinding(dir, value);
      await inDir(dir, async () => {
        await assert.rejects(() => resolveProjectBinding(), (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "USAGE");
          assert.match(err.message, detail);
          assert.match(err.message, /URL bindings no longer activate remotes/);
          assert.match(err.message, /pass --remote/);
          assert.ok(err.message.includes(value));
          return true;
        });
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectBinding: Windows drive paths remain filesystem intent, never unsupported one-letter URI schemes", async () => {
  const dir = await tempDir();
  try {
    for (const value of ["C:\\workspace\\bundle", "D:/workspace/bundle", "E:relative-bundle", "F:/"]) {
      await writeBinding(dir, value);
      await inDir(dir, async () => {
        const binding = await resolveProjectBinding();
        assert.equal(binding?.target, path.resolve(dir, value));
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectBinding: malformed JSON is a USAGE CliError naming the file", async () => {
  const dir = await tempDir();
  try {
    await writeRawBinding(dir, "{ not valid json");
    await inDir(dir, async () => {
      await assert.rejects(
        () => resolveProjectBinding(),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "USAGE");
          assert.equal(err.exitCode, 2);
          assert.match(err.message, /malformed project binding/);
          assert.ok(err.message.includes(path.join(dir, PROJECT_BINDING_FILE_NAME)));
          return true;
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectBinding: a missing, empty, or non-string 'bundle' field is a USAGE CliError naming the file — never a silent fallthrough", async () => {
  const dir = await tempDir();
  const file = path.join(dir, PROJECT_BINDING_FILE_NAME);
  try {
    for (const raw of ['{}', '{"bundle":""}', '{"bundle":"   "}', '{"bundle":123}', '{"bundle":null}']) {
      await writeRawBinding(dir, raw);
      await inDir(dir, async () => {
        await assert.rejects(
          () => resolveProjectBinding(),
          (err: unknown) => {
            assert.ok(err instanceof CliError, `expected a CliError for ${raw}`);
            assert.equal(err.code, "USAGE");
            assert.ok(err.message.includes(file), `message should name ${file} for ${raw}`);
            return true;
          },
        );
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── resolveRemoteFlag: precedence matrix ────────────────────────────────────

test("resolveRemoteFlag precedence: an explicit --remote flag wins outright over dirFlag, env, AND a URL project binding", async () => {
  const dir = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    await writeBinding(dir, "http://binding.example");
    process.env.AGENTSTATE_LITE_REMOTE = "http://env.example";
    await inDir(dir, async () => {
      const resolved = await resolveRemoteFlag("http://explicit.example", "/some/dir");
      assert.equal(resolved, "http://explicit.example");
    });
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRemoteFlag precedence: an explicit --dir suppresses BOTH the env default and a URL project binding, silently", async () => {
  const dir = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    await writeBinding(dir, "http://binding.example");
    process.env.AGENTSTATE_LITE_REMOTE = "http://env.example";
    await inDir(dir, async () => {
      const resolved = await resolveRemoteFlag(undefined, "/some/explicit/dir");
      assert.equal(resolved, undefined);
    });
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRemoteFlag: legacy AGENTSTATE_LITE_REMOTE is a deterministic migration error when no explicit target is given", async () => {
  const dir = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    await writeBinding(dir, "http://binding.example");
    process.env.AGENTSTATE_LITE_REMOTE = "http://env.example";
    await inDir(dir, async () => {
      await assert.rejects(() => resolveRemoteFlag(undefined, undefined), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /AGENTSTATE_LITE_REMOTE ambient remote selection is retired/);
        assert.match(err.help ?? "", /--remote http:\/\/env\.example/);
        return true;
      });
    });
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRemoteFlag: SUPERBEE_REMOTE is not an ambient remote binding", async () => {
  const dir = await tempDir();
  const priorLegacy = process.env.AGENTSTATE_LITE_REMOTE;
  const priorSuperbee = process.env.SUPERBEE_REMOTE;
  try {
    delete process.env.AGENTSTATE_LITE_REMOTE;
    process.env.SUPERBEE_REMOTE = "http://env.example";
    await inDir(dir, async () => {
      const resolved = await resolveRemoteFlag(undefined, undefined);
      assert.equal(resolved, undefined);
    });
  } finally {
    if (priorLegacy === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = priorLegacy;
    if (priorSuperbee === undefined) delete process.env.SUPERBEE_REMOTE;
    else process.env.SUPERBEE_REMOTE = priorSuperbee;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRemoteFlag: even a blank-but-present legacy env value errors instead of silently falling through local", async () => {
  const dir = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    process.env.AGENTSTATE_LITE_REMOTE = "   ";
    await inDir(dir, async () => {
      await assert.rejects(() => resolveRemoteFlag(undefined, undefined), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.help ?? "", /--remote <url>/);
        return true;
      });
    });
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRemoteFlag: a reached URL project binding errors instead of activating HTTP", async () => {
  const dir = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    delete process.env.AGENTSTATE_LITE_REMOTE;
    await writeBinding(dir, "http://binding.example");
    await inDir(dir, async () => {
      await assert.rejects(() => resolveRemoteFlag(undefined, undefined), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /pass --remote http:\/\/binding\.example explicitly/);
        return true;
      });
    });
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRemoteFlag: a directory-type binding is NOT a remote value — resolves to undefined (openBundle's own fallback consumes that half instead)", async () => {
  const dir = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    delete process.env.AGENTSTATE_LITE_REMOTE;
    await writeBinding(dir, "./somewhere");
    await inDir(dir, async () => {
      const resolved = await resolveRemoteFlag(undefined, undefined);
      assert.equal(resolved, undefined);
    });
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRemoteFlag: a malformed binding file throws USAGE ONLY when actually reached (no --dir, no env) — an explicit --dir suppresses it without ever reading the file", async () => {
  const dir = await tempDir();
  const prior = process.env.AGENTSTATE_LITE_REMOTE;
  try {
    delete process.env.AGENTSTATE_LITE_REMOTE;
    await writeRawBinding(dir, "not json at all");
    await inDir(dir, async () => {
      await assert.rejects(
        () => resolveRemoteFlag(undefined, undefined),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "USAGE");
          return true;
        },
      );
      // An explicit --dir suppresses the (malformed) binding SILENTLY — no throw at all.
      const resolved = await resolveRemoteFlag(undefined, "/anything");
      assert.equal(resolved, undefined);
    });
  } finally {
    if (prior === undefined) delete process.env.AGENTSTATE_LITE_REMOTE;
    else process.env.AGENTSTATE_LITE_REMOTE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── openBundle: the directory half + explicit---dir suppression ────────────

test("openBundle: a directory-type project binding resolves the bundle when neither --dir nor --remote is given", async () => {
  const root = await tempDir();
  try {
    const sharedBundle = path.join(root, "shared");
    await initBundle(sharedBundle);
    const projectDir = path.join(root, "project");
    await mkdir(projectDir, { recursive: true });
    await writeBinding(projectDir, "../shared");

    await inDir(projectDir, async () => {
      const bundle = await openBundle(undefined, undefined);
      assert.equal(bundle.root, path.resolve(sharedBundle));
      assert.equal("backend" in bundle, false, "a directory binding must never produce a RemoteBackend");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openBundle: a directory-type binding pointing at a missing path is NOT_FOUND (exit 6), naming the binding file", async () => {
  const root = await tempDir();
  try {
    const projectDir = path.join(root, "project");
    await mkdir(projectDir, { recursive: true });
    await writeBinding(projectDir, "../missing");

    await inDir(projectDir, async () => {
      await assert.rejects(
        () => openBundle(undefined, undefined),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "NOT_FOUND");
          assert.equal(err.exitCode, 6);
          assert.match(err.message, /project binding/);
          assert.ok(err.message.includes(path.join(projectDir, PROJECT_BINDING_FILE_NAME)));
          return true;
        },
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openBundle: a directory-type project binding is an exact boundary and accepts an index-less OKF bundle", async () => {
  const root = await tempDir();
  try {
    const indexless = path.join(root, "indexless");
    await mkdir(indexless);
    await writeFile(path.join(indexless, "note.md"), "---\ntype: Note\ntitle: Bound\n---\n\nhello\n");
    const projectDir = path.join(root, "project");
    await mkdir(projectDir);
    await writeBinding(projectDir, "../indexless");

    await inDir(projectDir, async () => {
      const bundle = await openBundle(undefined, undefined);
      assert.equal(bundle.root, indexless);
      let out = "";
      await list(["--json"], { stdout: (s) => (out += s) });
      const parsed = JSON.parse(out) as { count: number; docs: Array<{ id: string }> };
      assert.equal(parsed.count, 1);
      assert.equal(parsed.docs[0]?.id, "note");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openBundle: an explicit --dir suppresses a project binding SILENTLY — resolves the explicit dir even when a binding elsewhere points somewhere else", async () => {
  const root = await tempDir();
  try {
    const explicitBundle = path.join(root, "explicit");
    await initBundle(explicitBundle);
    const otherBundle = path.join(root, "other");
    await initBundle(otherBundle);
    const projectDir = path.join(root, "project");
    await mkdir(projectDir, { recursive: true });
    await writeBinding(projectDir, "../other");

    await inDir(projectDir, async () => {
      const bundle = await openBundle(explicitBundle, undefined);
      assert.equal(bundle.root, path.resolve(explicitBundle));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openBundle: an explicit --dir may name a project directory containing the conventional bundle", async () => {
  const project = await tempDir();
  try {
    const conventional = path.join(project, CONVENTIONAL_BUNDLE_DIR_NAME);
    await initBundle(conventional);

    const bundle = await openBundle(project, undefined);
    assert.equal(bundle.root, conventional);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("openBundle: an existing explicit --dir inside another bundle remains its own exact index-less boundary", async () => {
  const project = await tempDir();
  try {
    const conventional = path.join(project, CONVENTIONAL_BUNDLE_DIR_NAME);
    await initBundle(conventional);
    const nested = path.join(project, "src");
    await mkdir(nested);

    const bundle = await openBundle(nested, undefined);
    assert.equal(bundle.root, nested);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("openBundle: an explicit index-less directory suppresses a project binding instead of merging selection rungs", async () => {
  const root = await tempDir();
  try {
    const otherBundle = path.join(root, "other");
    await initBundle(otherBundle);
    const projectDir = path.join(root, "project");
    await mkdir(projectDir, { recursive: true });
    await writeBinding(projectDir, "../other");
    const badDir = path.join(root, "not-a-bundle");
    await mkdir(badDir, { recursive: true });

    await inDir(projectDir, async () => {
      const bundle = await openBundle(badDir, undefined);
      assert.equal(bundle.root, badDir);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openBundle: explicit nonexistent and non-directory targets remain NOT_FOUND and never retarget an ancestor", async () => {
  const root = await tempDir();
  try {
    await initBundle(root);
    const missing = path.join(root, "missing");
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "not a bundle directory");

    for (const target of [missing, file]) {
      await assert.rejects(
        () => openBundle(target, undefined),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "NOT_FOUND");
          assert.match(err.message, /no local bundle directory/);
          assert.ok(err.help?.includes(`--dir ${root}`));
          assert.doesNotMatch(err.help ?? "", / init /);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openBundle: explicit --dir consumes an index-less OKF bundle, while ambient discovery still refuses to guess it", async () => {
  const root = await tempDir();
  try {
    await writeFile(path.join(root, "note.md"), "---\ntype: Note\ntitle: Index-less\n---\n\nhello\n");

    const explicit = await openBundle(root, undefined);
    assert.equal(explicit.root, root);
    let out = "";
    await list(["--dir", root, "--json"], { stdout: (s) => (out += s) });
    const parsed = JSON.parse(out) as { count: number; docs: Array<{ id: string }> };
    assert.equal(parsed.count, 1);
    assert.equal(parsed.docs[0]?.id, "note");

    await inDir(root, async () => {
      await assert.rejects(
        () => openBundle(undefined, undefined),
        (err: unknown) => err instanceof CliError && err.code === "NOT_FOUND",
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openBundle: a reached URL binding errors actionably instead of silently falling through", async () => {
  const dir = await tempDir();
  try {
    await writeBinding(dir, "http://127.0.0.1:1"); // nothing need listen here — never fetched
    await inDir(dir, async () => {
      await assert.rejects(
        () => openBundle(undefined, undefined),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "USAGE");
          assert.match(err.message, /pass --remote/);
          return true;
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── end-to-end: a URL binding cannot drive a bare command ─

test("end-to-end: a bare command with a URL binding fails before any HTTP request", async () => {
  const projectDir = await tempDir();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  try {
    const url = "http://must-not-fetch.example";
    await writeBinding(projectDir, url);
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("unexpected fetch");
    }) as typeof fetch;

    await inDir(projectDir, async () => {
      await assert.rejects(() => list(["--json"], {}), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /pass --remote/);
        return true;
      });
      assert.equal(fetches, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectDir, { recursive: true, force: true });
  }
});

// ── conventional-folder discovery: canonical + legacy names, with dual-name refusal ─────

test("openBundle: a conventional .superbee/ bundle at an ancestor is discovered bare — no flags, no env, no binding", async () => {
  const project = await tempDir();
  try {
    const conventional = path.join(project, CONVENTIONAL_BUNDLE_DIR_NAME);
    await initBundle(conventional);
    const nested = path.join(project, "src", "deep");
    await mkdir(nested, { recursive: true });
    await inDir(nested, async () => {
      const bundle = await openBundle(undefined, undefined);
      assert.equal(bundle.root, conventional);
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("openBundle: an existing legacy .agentstate-lite/ bundle remains discoverable in place", async () => {
  const project = await tempDir();
  try {
    const legacy = path.join(project, LEGACY_CONVENTIONAL_BUNDLE_DIR_NAME);
    await initBundle(legacy);
    const nested = path.join(project, "src", "deep");
    await mkdir(nested, { recursive: true });
    await inDir(nested, async () => {
      const bundle = await openBundle(undefined, undefined);
      assert.equal(bundle.root, legacy);
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("openBundle: same-level canonical and legacy bundles fail closed", async () => {
  const project = await tempDir();
  try {
    await initBundle(path.join(project, CONVENTIONAL_BUNDLE_DIR_NAME));
    await initBundle(path.join(project, LEGACY_CONVENTIONAL_BUNDLE_DIR_NAME));
    await inDir(project, async () => {
      await assert.rejects(
        () => openBundle(undefined, undefined),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "CONFLICT");
          assert.match(err.message, /refusing to choose between two project bundles/);
          return true;
        },
      );
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("openBundle: standing INSIDE a bundle beats a conventional folder at the same level — index.md is checked first per level", async () => {
  const project = await tempDir();
  try {
    // project/ is itself a bundle AND carries a conventional subfolder bundle.
    await initBundle(project);
    const conventional = path.join(project, CONVENTIONAL_BUNDLE_DIR_NAME);
    await initBundle(conventional);
    await inDir(project, async () => {
      const bundle = await openBundle(undefined, undefined);
      assert.equal(bundle.root, project);
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("openBundle: the NEAREST level wins — a nested dir's conventional folder beats an ancestor's", async () => {
  const project = await tempDir();
  try {
    const outer = path.join(project, CONVENTIONAL_BUNDLE_DIR_NAME);
    await initBundle(outer);
    const sub = path.join(project, "packages", "app");
    const inner = path.join(sub, CONVENTIONAL_BUNDLE_DIR_NAME);
    await initBundle(inner);
    await inDir(sub, async () => {
      const bundle = await openBundle(undefined, undefined);
      assert.equal(bundle.root, inner);
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("openBundle: a directory-type .agentstate.json binding BEATS the conventional folder (committed beats discovered)", async () => {
  const project = await tempDir();
  const elsewhere = await tempDir();
  try {
    await initBundle(path.join(project, CONVENTIONAL_BUNDLE_DIR_NAME));
    await initBundle(elsewhere);
    await writeBinding(project, elsewhere);
    await inDir(project, async () => {
      const bundle = await openBundle(undefined, undefined);
      assert.equal(bundle.root, elsewhere);
    });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("openBundle: an explicit --dir beats the conventional folder, and a bare .superbee/ WITHOUT index.md is not a bundle (no false positive)", async () => {
  const project = await tempDir();
  const explicit = await tempDir();
  try {
    await initBundle(path.join(project, CONVENTIONAL_BUNDLE_DIR_NAME));
    await initBundle(explicit);
    await inDir(project, async () => {
      const bundle = await openBundle(explicit, undefined);
      assert.equal(bundle.root, explicit);
    });
    // An empty conventional folder (no index.md) must fall through to NOT_FOUND, and the
    // error must name BOTH forms it looked for plus the conventional init hint.
    const empty = await tempDir();
    try {
      await mkdir(path.join(empty, CONVENTIONAL_BUNDLE_DIR_NAME));
      await inDir(empty, async () => {
        await assert.rejects(
          () => openBundle(undefined, undefined),
          (err: unknown) => {
            assert.ok(err instanceof CliError);
            assert.equal(err.code, "NOT_FOUND");
            assert.match(err.message, /\.superbee\/index\.md/);
            return true;
          },
        );
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(explicit, { recursive: true, force: true });
  }
});

test("openBundle: an explicit --dir bypasses an otherwise conflicting same-level binding pair", async () => {
  const project = await tempDir();
  const explicit = await tempDir();
  try {
    await initBundle(explicit);
    await writeBinding(project, "one", SUPERBEE_PROJECT_BINDING_FILE_NAME);
    await writeBinding(project, "two", PROJECT_BINDING_FILE_NAME);

    await inDir(project, async () => {
      const bundle = await openBundle(explicit, undefined);
      assert.equal(bundle.root, explicit);
    });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(explicit, { recursive: true, force: true });
  }
});

test("end-to-end: a bare `list` from a nested cwd rides conventional-folder discovery to a real bundle", async () => {
  const project = await tempDir();
  try {
    const conventional = path.join(project, CONVENTIONAL_BUNDLE_DIR_NAME);
    await initBundle(conventional);
    await writeDoc(
      { root: conventional },
      { id: "specs/demo", frontmatter: { type: "Spec", title: "Demo" }, body: "hello" },
    );
    const nested = path.join(project, "src");
    await mkdir(nested, { recursive: true });
    await inDir(nested, async () => {
      let out = "";
      await list(["--json"], { stdout: (s) => (out += s) });
      const parsed = JSON.parse(out) as { count: number; docs: Array<{ id: string }> };
      assert.equal(parsed.count, 1);
      assert.equal(parsed.docs[0]?.id, "specs/demo");
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
