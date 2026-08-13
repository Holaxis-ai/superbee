/**
 * `init --create-only` — the shared onboarding target-safety boundary (tasks/init-target-safety-guard).
 *
 * The guard's contract: create a bundle ONLY at a genuinely new target, refusing — before any
 * write — existing bundles, non-empty or symlinked targets, enclosing bundles/workspaces, and
 * binding-shadowed locations; a CONCURRENT creator is turned into a typed conflict by core
 * `initBundle`'s `expectNew` expect-absent CAS rather than silently adopted. Every refusal is
 * byte-preserving: these tests snapshot the target tree before the refused call and require it
 * unchanged after. Plain `init` (no flag) keeps its open-or-create behavior (its own suites pin
 * that; one control test here re-proves the exact case the guard refuses).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, promises as fsPromises, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FilesystemMutationLockError,
  initBundle,
  VersionConflict,
  withFilesystemMutationLock,
} from "@superbee/core";
import { init } from "../src/commands/init.js";
import {
  assertCreateOnlyTarget,
  createOnlyArbitrationLockKey,
  PROJECT_BINDING_FILE_NAME,
  resolveProjectBinding,
  SUPERBEE_PROJECT_BINDING_FILE_NAME,
  withCreateOnlyTarget,
} from "../src/bundle.js";
import { CliError } from "../src/errors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliBin = path.resolve(here, "..", "dist", "superbee.mjs");

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-create-only-test-"));
}

async function runInit(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await init([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

/** Recursive { relativePath -> content } snapshot for byte-preservation assertions. */
async function treeSnapshot(dir: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  if (!existsSync(dir)) return entries;
  async function walk(rel: string): Promise<void> {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) await walk(child);
      else entries.set(child, await readFile(path.join(dir, child), "utf8"));
    }
  }
  await walk("");
  return entries;
}

function assertSameTree(before: Map<string, string>, after: Map<string, string>): void {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [key, content] of before) assert.equal(after.get(key), content, key);
}

async function expectRefusal(argv: string[], pattern: RegExp): Promise<CliError> {
  let thrown: unknown;
  try {
    await runInit(argv);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof CliError, "refusal must be a structured CliError");
  assert.match(thrown.message, pattern);
  return thrown;
}

test("a fresh explicit target initializes with every supported recipe form", async () => {
  const base = await tempDir();
  try {
    // Default recipe (context-notes).
    const withDefault = await runInit(["--create-only", "--dir", path.join(base, "a")]);
    assert.equal(withDefault.init, "ok");
    assert.equal(withDefault.recipe, "context-notes");
    // Explicit opt-out.
    const bare = await runInit(["--create-only", "--dir", path.join(base, "b"), "--recipe", "none"]);
    assert.equal(bare.recipe, "none");
    // A named built-in.
    const named = await runInit([
      "--create-only",
      "--dir",
      path.join(base, "c"),
      "--recipe",
      "work-tracking",
    ]);
    assert.equal(named.recipe, "work-tracking");
    // A path-form recipe folder — the shipped worked example, exercising the external RecipeSource.
    const recipeDir = path.resolve(here, "..", "references", "recipes", "claims");
    const fromPath = await runInit(["--create-only", "--dir", path.join(base, "d"), "--recipe", recipeDir]);
    assert.equal(fromPath.init, "ok");
    assert.equal(fromPath.recipe, "claims");
    // Deep target whose intermediate ancestors do not exist yet.
    const deep = await runInit(["--create-only", "--dir", path.join(base, "x", "y", "z")]);
    assert.equal(deep.init, "ok");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an existing bundle target is refused byte-for-byte before any write", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "bundle");
    await runInit(["--dir", target]); // plain init creates it (control: open-or-create unchanged)
    const before = await treeSnapshot(target);
    const err = await expectRefusal(["--create-only", "--dir", target], /already an OKF bundle/);
    assert.equal(err.code, "ALREADY_EXISTS");
    assert.match(String(err.help), /recipe add/);
    assertSameTree(before, await treeSnapshot(target));
    // The control the guard exists to contrast with: plain init re-opens the same target fine.
    assert.equal((await runInit(["--dir", target])).init, "ok");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("plain init keeps open-or-create Recipe transition and idempotence", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "plain");
    await runInit(["--dir", target, "--recipe", "none"]);
    const indexBefore = await readFile(path.join(target, "index.md"), "utf8");
    const applied = await runInit(["--dir", target, "--recipe", "work-tracking"]);
    assert.equal(applied.recipe, "work-tracking");
    assert.equal(await readFile(path.join(target, "index.md"), "utf8"), indexBefore);
    const beforeRepeat = await treeSnapshot(target);
    await runInit(["--dir", target, "--recipe", "work-tracking"]);
    assertSameTree(beforeRepeat, await treeSnapshot(target));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a target nested inside an enclosing bundle is refused; conventional ancestor workspaces too", async () => {
  const base = await tempDir();
  try {
    // Enclosing bundle: an ancestor with its own index.md.
    const enclosingRoot = path.join(base, "enclosing");
    await runInit(["--dir", enclosingRoot, "--recipe", "none"]);
    const before = await treeSnapshot(enclosingRoot);
    await expectRefusal(
      ["--create-only", "--dir", path.join(enclosingRoot, "sub", "deep")],
      /nest inside the existing bundle/,
    );
    assertSameTree(before, await treeSnapshot(enclosingRoot));

    // Conventional workspace at an ancestor: <proj>/.agentstate-lite exists -> join it, not a second store.
    const proj = path.join(base, "proj");
    await runInit(["--dir", path.join(proj, ".agentstate-lite"), "--recipe", "none"]);
    await expectRefusal(
      ["--create-only", "--dir", path.join(proj, "docs", "new-bundle")],
      /existing project workspace .* already serves this location/,
    );

    // But creating the conventional folder ITSELF in a fresh project is allowed.
    const fresh = path.join(base, "fresh-proj");
    await mkdir(fresh, { recursive: true });
    const receipt = await runInit(["--create-only", "--dir", path.join(fresh, ".agentstate-lite")]);
    assert.equal(receipt.init, "ok");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("bindings: an existing bound bundle refuses; malformed and URL bindings keep their USAGE errors", async () => {
  const base = await tempDir();
  try {
    const proj = path.join(base, "proj");
    const bound = path.join(base, "workspace");
    await runInit(["--dir", bound, "--recipe", "none"]);
    await mkdir(path.join(proj, "sub"), { recursive: true });
    await writeFile(path.join(proj, ".agentstate.json"), `${JSON.stringify({ bundle: bound })}\n`);
    const err = await expectRefusal(
      ["--create-only", "--dir", path.join(proj, "sub", "new-bundle")],
      /project binding .* already resolves this location to the existing bundle/,
    );
    assert.equal(err.code, "ALREADY_EXISTS");

    // A binding pointing at a bundle that does NOT exist is not "an existing bundle" — allowed.
    const proj2 = path.join(base, "proj2");
    await mkdir(proj2, { recursive: true });
    await writeFile(
      path.join(proj2, ".agentstate.json"),
      `${JSON.stringify({ bundle: path.join(base, "nowhere") })}\n`,
    );
    assert.equal((await runInit(["--create-only", "--dir", path.join(proj2, "nb")])).init, "ok");

    // Malformed JSON binding: the existing fail-closed USAGE error, unchanged wording family.
    const proj3 = path.join(base, "proj3");
    await mkdir(proj3, { recursive: true });
    await writeFile(path.join(proj3, ".agentstate.json"), "{not json");
    const malformed = await expectRefusal(
      ["--create-only", "--dir", path.join(proj3, "nb")],
      /malformed project binding/,
    );
    assert.equal(malformed.code, "USAGE");

    // URL-valued binding: the existing explicit-remote migration error.
    const proj4 = path.join(base, "proj4");
    await mkdir(proj4, { recursive: true });
    await writeFile(
      path.join(proj4, ".agentstate.json"),
      `${JSON.stringify({ bundle: "https://example.com/b" })}\n`,
    );
    const url = await expectRefusal(["--create-only", "--dir", path.join(proj4, "nb")], /URL bindings/);
    assert.equal(url.code, "USAGE");

    // The preferred binding participates in the same strict create-only discovery.
    const proj5 = path.join(base, "proj5");
    await mkdir(proj5, { recursive: true });
    await writeFile(
      path.join(proj5, SUPERBEE_PROJECT_BINDING_FILE_NAME),
      `${JSON.stringify({ bundle: bound })}\n`,
    );
    const preferred = await expectRefusal(
      ["--create-only", "--dir", path.join(proj5, "new-bundle")],
      /project binding .*\.superbee\.json already resolves this location/,
    );
    assert.equal(preferred.code, "ALREADY_EXISTS");

    // Both names at one level are an ambiguity before either target is considered.
    const proj6 = path.join(base, "proj6");
    await mkdir(proj6, { recursive: true });
    await writeFile(
      path.join(proj6, SUPERBEE_PROJECT_BINDING_FILE_NAME),
      `${JSON.stringify({ bundle: bound })}\n`,
    );
    await writeFile(
      path.join(proj6, PROJECT_BINDING_FILE_NAME),
      `${JSON.stringify({ bundle: bound })}\n`,
    );
    const conflict = await expectRefusal(
      ["--create-only", "--dir", path.join(proj6, "new-bundle")],
      /conflicting project bindings/,
    );
    assert.equal(conflict.code, "USAGE");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("create-only binding discovery matches ordinary discovery for symlinked binding files and targets", async () => {
  const base = await tempDir();
  try {
    const symlinkedBindingProject = path.join(base, "symlinked-binding-project");
    const bindingSource = path.join(base, "binding-source.json");
    const emptyBoundTarget = path.join(base, "empty-bound-target");
    await mkdir(symlinkedBindingProject, { recursive: true });
    await mkdir(emptyBoundTarget);
    await writeFile(bindingSource, `${JSON.stringify({ bundle: emptyBoundTarget })}\n`);
    const symlinkedBindingFile = path.join(symlinkedBindingProject, ".agentstate.json");
    await symlink(bindingSource, symlinkedBindingFile);
    assert.deepEqual(await resolveProjectBinding(symlinkedBindingProject), {
      file: symlinkedBindingFile,
      target: emptyBoundTarget,
    });

    const throughSymlinkedBinding = await runInit([
      "--create-only",
      "--dir",
      path.join(symlinkedBindingProject, "new-bundle"),
      "--recipe",
      "none",
    ]);
    assert.equal(throughSymlinkedBinding.init, "ok");

    const targetAliasProject = path.join(base, "target-alias-project");
    const targetAlias = path.join(base, "empty-bound-target-alias");
    await mkdir(targetAliasProject, { recursive: true });
    await symlink(emptyBoundTarget, targetAlias);
    await writeFile(
      path.join(targetAliasProject, ".agentstate.json"),
      `${JSON.stringify({ bundle: targetAlias })}\n`,
    );
    assert.equal((await resolveProjectBinding(targetAliasProject))?.target, targetAlias);

    const throughSymlinkedTarget = await runInit([
      "--create-only",
      "--dir",
      path.join(targetAliasProject, "new-bundle"),
      "--recipe",
      "none",
    ]);
    assert.equal(throughSymlinkedTarget.init, "ok");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("create-only rejects binding symlinks to FIFOs promptly for both supported names", async (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo is unavailable on Windows");
    return;
  }
  const base = await tempDir();
  try {
    const fifo = path.join(base, "binding-source");
    execFileSync("mkfifo", [fifo]);

    for (const name of [SUPERBEE_PROJECT_BINDING_FILE_NAME, PROJECT_BINDING_FILE_NAME]) {
      await t.test(name, async () => {
        const project = path.join(base, name.slice(1, -5));
        const target = path.join(project, "new-bundle");
        await mkdir(project);
        await symlink(fifo, path.join(project, name));

        const result = spawnSync(
          process.execPath,
          [cliBin, "init", "--create-only", "--dir", target, "--recipe", "none", "--json"],
          { encoding: "utf8", timeout: 2_000 },
        );

        assert.notEqual((result.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
        assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /project binding .* must be a regular file/);
        assert.equal(existsSync(target), false, "a refused binding must not create the target");
      });
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("stable direct and symlink binding targets to the same non-directory both permit create-only", async (t) => {
  const base = await tempDir();
  try {
    const boundFile = path.join(base, "stable-non-bundle");
    const boundAlias = path.join(base, "stable-non-bundle-alias");
    await writeFile(boundFile, "not a bundle\n");
    await symlink(boundFile, boundAlias);

    for (const [shape, boundTarget] of [
      ["direct", boundFile],
      ["symlink", boundAlias],
    ] as const) {
      await t.test(shape, async () => {
        const project = path.join(base, `${shape}-project`);
        await mkdir(project);
        await writeFile(
          path.join(project, ".agentstate.json"),
          `${JSON.stringify({ bundle: boundTarget })}\n`,
        );

        const receipt = await runInit([
          "--create-only",
          "--dir",
          path.join(project, "new-bundle"),
          "--recipe",
          "none",
        ]);
        assert.equal(receipt.init, "ok");
        assert.equal(await readFile(boundFile, "utf8"), "not a bundle\n");
      });
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("binding target effective snapshots follow symlinks exactly once and reuse direct lstat", async (t) => {
  const base = await tempDir();
  try {
    const boundFile = path.join(base, "stable-non-bundle");
    const boundAlias = path.join(base, "stable-non-bundle-alias");
    await writeFile(boundFile, "not a bundle\n");
    await symlink(boundFile, boundAlias);

    for (const [shape, boundTarget, expectedStatCalls] of [
      ["direct", boundFile, 0],
      ["symlink", boundAlias, 1],
    ] as const) {
      await t.test(shape, async () => {
        const project = path.join(base, `${shape}-snapshot-project`);
        const newBundle = path.join(project, "new-bundle");
        await mkdir(project);
        await writeFile(
          path.join(project, ".agentstate.json"),
          `${JSON.stringify({ bundle: boundTarget })}\n`,
        );
        let statCalls = 0;

        await assertCreateOnlyTarget(newBundle, process.cwd(), {
          fs: {
            stat: async (p) => {
              assert.equal(p, boundTarget);
              statCalls += 1;
              return fsPromises.stat(p);
            },
          },
        });
        assert.equal(statCalls, expectedStatCalls);
      });
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("binding target observer rejects witnessed shape and identity transitions", async (t) => {
  for (const [shape, transition, expectedOperation, expectedCode] of [
    ["direct", "directory-to-file", "validate-resolved-binding-target-shape", "ESHAPE"],
    ["symlink", "directory-to-file", "validate-resolved-binding-target-shape", "ESHAPE"],
    ["symlink", "resolved-symlink", "validate-resolved-binding-target-shape", "ESHAPE"],
    ["direct", "directory-replacement", "validate-resolved-binding-target-identity", "EPATHCHANGED"],
    ["symlink", "directory-replacement", "validate-resolved-binding-target-identity", "EPATHCHANGED"],
  ] as const) {
    await t.test(`${shape} ${transition}`, async () => {
      const base = await tempDir();
      try {
        const physicalBase = await fsPromises.realpath(base);
        const project = path.join(physicalBase, "project");
        const observedDirectory = path.join(physicalBase, "observed-directory");
        const replacement = path.join(physicalBase, "replacement");
        await mkdir(project);
        await mkdir(observedDirectory);
        if (transition === "directory-to-file") await writeFile(replacement, "replacement\n");
        else if (transition === "resolved-symlink") await symlink(observedDirectory, replacement);
        else await mkdir(replacement);
        const replacementInfo = await fsPromises.lstat(replacement);
        const boundTarget =
          shape === "symlink" ? path.join(physicalBase, "observed-directory-alias") : observedDirectory;
        if (shape === "symlink") await symlink(observedDirectory, boundTarget);
        await writeFile(
          path.join(project, ".agentstate.json"),
          `${JSON.stringify({ bundle: boundTarget })}\n`,
        );

        let physicalLstatCalls = 0;
        let publishCalled = false;
        const newBundle = path.join(project, "new-bundle");
        await assert.rejects(
          () =>
            withCreateOnlyTarget(
              newBundle,
              async () => {
                publishCalled = true;
              },
              process.cwd(),
              {
                fs: {
                  lstat: async (p) => {
                    if (p === observedDirectory) {
                      physicalLstatCalls += 1;
                      const finalSnapshot = shape === "direct" ? physicalLstatCalls === 2 : true;
                      if (finalSnapshot) return replacementInfo;
                    }
                    return fsPromises.lstat(p);
                  },
                },
              },
            ),
          (err: unknown) =>
            err instanceof CliError &&
            err.code === "RUNTIME" &&
            err.details?.phase === "preflight" &&
            err.details.operation === expectedOperation &&
            err.details.path === observedDirectory &&
            err.details.fs_code === expectedCode,
        );
        assert.equal(publishCalled, false);
        assert.equal(existsSync(path.join(newBundle, "index.md")), false);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  }
});

test("binding target observer faults retain exact operation, path, and fs code", async (t) => {
  for (const [fault, expectedOperation, expectedCode] of [
    ["followed-stat", "stat-binding-target", "EIO"],
    ["dangling", "stat-binding-target", "ENOENT"],
    ["realpath", "realpath-binding-target", "EIO"],
    ["resolved-lstat", "lstat-resolved-binding-target", "EIO"],
  ] as const) {
    await t.test(fault, async () => {
      const base = await tempDir();
      try {
        const physicalBase = await fsPromises.realpath(base);
        const project = path.join(physicalBase, "project");
        const physicalBoundTarget = path.join(physicalBase, "bound-target");
        await mkdir(project);
        let boundTarget = physicalBoundTarget;
        if (fault === "dangling") {
          boundTarget = path.join(physicalBase, "dangling-alias");
          await symlink(physicalBoundTarget, boundTarget);
        } else {
          await mkdir(physicalBoundTarget);
          if (fault === "followed-stat") {
            boundTarget = path.join(physicalBase, "bound-target-alias");
            await symlink(physicalBoundTarget, boundTarget);
          }
        }
        await writeFile(
          path.join(project, ".agentstate.json"),
          `${JSON.stringify({ bundle: boundTarget })}\n`,
        );

        let physicalLstatCalls = 0;
        const deps =
          fault === "followed-stat"
            ? {
                fs: {
                  stat: async (p: string) => {
                    if (p === boundTarget) throw Object.assign(new Error("injected followed stat fault"), { code: "EIO" });
                    return fsPromises.stat(p);
                  },
                },
              }
            : fault === "realpath"
              ? {
                  fs: {
                    realpath: async (p: string) => {
                      if (p === boundTarget) throw Object.assign(new Error("injected realpath fault"), { code: "EIO" });
                      return fsPromises.realpath(p);
                    },
                  },
                }
              : fault === "resolved-lstat"
                ? {
                    fs: {
                      lstat: async (p: string) => {
                        if (p === physicalBoundTarget) {
                          physicalLstatCalls += 1;
                          if (physicalLstatCalls === 2) {
                            throw Object.assign(new Error("injected resolved lstat fault"), { code: "EIO" });
                          }
                        }
                        return fsPromises.lstat(p);
                      },
                    },
                  }
                : {};

        const newBundle = path.join(project, "new-bundle");
        await assert.rejects(
          () => assertCreateOnlyTarget(newBundle, process.cwd(), deps),
          (err: unknown) =>
            err instanceof CliError &&
            err.code === "RUNTIME" &&
            err.details?.phase === "preflight" &&
            err.details.operation === expectedOperation &&
            err.details.path === boundTarget &&
            err.details.fs_code === expectedCode,
        );
        assert.equal(existsSync(path.join(newBundle, "index.md")), false);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  }
});

test("binding targets that disappear after realpath fail closed for direct and symlink paths", async (t) => {
  for (const shape of ["direct", "symlink"] as const) {
    await t.test(shape, async () => {
      const base = await tempDir();
      try {
        const project = path.join(base, "project");
        const logicalBoundTarget = path.join(base, "empty-bound-target");
        await mkdir(project, { recursive: true });
        await mkdir(logicalBoundTarget);
        const physicalBoundTarget = await fsPromises.realpath(logicalBoundTarget);
        const boundTarget =
          shape === "symlink" ? path.join(base, "empty-bound-target-alias") : logicalBoundTarget;
        if (shape === "symlink") await symlink(logicalBoundTarget, boundTarget);
        await writeFile(
          path.join(project, ".agentstate.json"),
          `${JSON.stringify({ bundle: boundTarget })}\n`,
        );

        let boundTargetResolved = false;
        let publishCalled = false;
        await assert.rejects(
          () =>
            withCreateOnlyTarget(
              path.join(project, "new-bundle"),
              async () => {
                publishCalled = true;
              },
              process.cwd(),
              {
                fs: {
                  realpath: async (p) => {
                    const resolved = await fsPromises.realpath(p);
                    if (p === boundTarget) {
                      assert.equal(resolved, physicalBoundTarget);
                      boundTargetResolved = true;
                    }
                    return resolved;
                  },
                  lstat: async (p) => {
                    if (boundTargetResolved && p === physicalBoundTarget) {
                      throw Object.assign(new Error("injected post-realpath disappearance"), {
                        code: "ENOENT",
                        path: physicalBoundTarget,
                      });
                    }
                    return fsPromises.lstat(p);
                  },
                },
              },
            ),
          (err: unknown) =>
            err instanceof CliError &&
            err.code === "RUNTIME" &&
            err.details?.phase === "preflight" &&
            err.details.operation === "lstat-resolved-binding-target" &&
            err.details.path === physicalBoundTarget &&
            err.details.fs_code === "ENOENT",
        );
        assert.equal(boundTargetResolved, true);
        assert.equal(publishCalled, false);
        assert.equal(existsSync(path.join(project, "new-bundle", "index.md")), false);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  }
});

test("symlink targets and symlinked ancestor aliases cannot dodge the guard", async () => {
  const base = await tempDir();
  try {
    // A symlink AT the target — even to an empty real directory — is an alias refusal.
    const real = path.join(base, "real-empty");
    await mkdir(real);
    const alias = path.join(base, "alias");
    await symlink(real, alias);
    const err = await expectRefusal(["--create-only", "--dir", alias], /is a symlink/);
    assert.equal(err.code, "ALREADY_EXISTS");
    assert.equal((await readdir(real)).length, 0, "nothing was written through the alias");

    // A symlinked ANCESTOR that resolves into an existing bundle: physical resolution finds the
    // enclosing bundle the logical path hides.
    const bundleRoot = path.join(base, "bundle");
    await runInit(["--dir", bundleRoot, "--recipe", "none"]);
    const sideDoor = path.join(base, "side-door");
    await symlink(bundleRoot, sideDoor);
    const before = await treeSnapshot(bundleRoot);
    await expectRefusal(
      ["--create-only", "--dir", path.join(sideDoor, "inner", "fresh")],
      /nest inside the existing bundle/,
    );
    assertSameTree(before, await treeSnapshot(bundleRoot));

    // A non-empty, non-bundle directory must not be adopted as a "new" workspace.
    const cluttered = path.join(base, "cluttered");
    await mkdir(cluttered);
    await writeFile(path.join(cluttered, "notes.txt"), "keep\n");
    await expectRefusal(["--create-only", "--dir", cluttered], /is not empty/);
    assert.equal(readFileSync(path.join(cluttered, "notes.txt"), "utf8"), "keep\n");

    // A plain FILE at the target.
    const file = path.join(base, "a-file");
    await writeFile(file, "x\n");
    await expectRefusal(["--create-only", "--dir", file], /not a directory/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("core expectNew: a concurrent index.md is a typed VersionConflict, never silent adoption", async () => {
  const base = await tempDir();
  try {
    const dir = path.join(base, "raced");
    await initBundle(dir, {}); // the "other" creator finished first
    await assert.rejects(() => initBundle(dir, { expectNew: true }), VersionConflict);
    // And the preflight primitive alone performs no writes on a fresh path. The returned target
    // is PHYSICAL (e.g. macOS /var -> /private/var), so compare against the realpath'd base.
    const fresh = path.join(base, "untouched");
    const resolved = await assertCreateOnlyTarget(fresh);
    const { realpath } = await import("node:fs/promises");
    assert.equal(resolved, path.join(await realpath(base), "untouched"));
    assert.equal(existsSync(fresh), false, "the preflight must not create anything");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("two real concurrent create-only processes: exactly one winner, loser exits 5 with no partial state", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "raced");
    const spawnOne = () =>
      spawnSync(process.execPath, [cliBin, "init", "--create-only", "--dir", target, "--json"], {
        encoding: "utf8",
      });
    // True simultaneity is not schedulable from here; run the pair sequentially — the SECOND run
    // exercises the exact loser path (existing-bundle refusal), and the CAS loser path is pinned
    // deterministically by the core expectNew test above.
    const first = spawnOne();
    const second = spawnOne();
    const codes = [first.status, second.status].sort();
    assert.deepEqual(codes, [0, 5], `${first.stdout}${first.stderr}${second.stdout}${second.stderr}`);
    const winner = first.status === 0 ? first : second;
    assert.equal(JSON.parse(winner.stdout).init, "ok");
    const loser = first.status === 0 ? second : first;
    assert.match(loser.stdout, /already an OKF bundle|gained a bundle concurrently/);
    assert.ok(existsSync(path.join(target, "index.md")), "the winner's bundle stands");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("permission failure surfaces as a structured error, not a crash or partial write", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("running as root — permission refusals are not enforceable");
    return;
  }
  const base = await tempDir();
  try {
    const sealed = path.join(base, "sealed");
    await mkdir(sealed);
    const { chmod } = await import("node:fs/promises");
    await chmod(sealed, 0o555);
    try {
      let thrown: unknown;
      try {
        await runInit(["--create-only", "--dir", path.join(sealed, "nb")]);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof Error, "a denied write must surface as an error");
      assert.equal(existsSync(path.join(sealed, "nb")), false);
    } finally {
      await chmod(sealed, 0o755);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("usage text and reference carry the exact public spelling", async () => {
  const { INIT_USAGE } = await import("../src/commands/init.js");
  assert.match(INIT_USAGE, /--create-only/);
  const { COMMAND_GROUPS } = await import("../src/reference.js");
  const entry = COMMAND_GROUPS.flatMap((g) => g.commands).find((c) => c.usage.startsWith("init "));
  assert.ok(entry, "init entry present");
  assert.match(entry.usage, /\[--create-only\]/);
});

// ── review-fix round: findings from the independent exact-SHA review of e84a66e ──

test("dangling and looping symlink targets refuse at exit 5 with recovery help, never a raw fs error", async () => {
  const base = await tempDir();
  try {
    const dangling = path.join(base, "dangling");
    await symlink(path.join(base, "nowhere"), dangling);
    const err = await expectRefusal(["--create-only", "--dir", dangling], /is a symlink/);
    assert.equal(err.code, "ALREADY_EXISTS");
    assert.match(String(err.help), /recipe add/);

    const loop = path.join(base, "loop");
    await symlink(loop, loop);
    const looping = await expectRefusal(["--create-only", "--dir", loop], /is a symlink/);
    assert.equal(looping.code, "ALREADY_EXISTS");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the CLI maps a core VersionConflict to a structured ALREADY_EXISTS conflict (seam-pinned)", async () => {
  const base = await tempDir();
  try {
    let out = "";
    let thrown: unknown;
    try {
      await init(["--create-only", "--dir", path.join(base, "raced"), "--json"], {
        stdout: (s) => (out += s),
        initBundleImpl: async () => {
          throw new VersionConflict("index.md", null, "sha256:other");
        },
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof CliError, out);
    assert.equal(thrown.code, "ALREADY_EXISTS");
    assert.match(thrown.message, /gained a bundle concurrently/);
    assert.match(String(thrown.help), /recipe add/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("locked revalidation refuses content or a symlink introduced after preflight", async () => {
  const base = await tempDir();
  try {
    const raced = path.join(base, "raced-dir");
    await assert.rejects(
      () =>
        withCreateOnlyTarget(raced, () => initBundle(raced, { expectNew: true }), process.cwd(), {
          withFilesystemMutationLockImpl: async (_key, fn) => {
            await mkdir(raced);
            await writeFile(path.join(raced, "theirs.txt"), "keep\n");
            return fn();
          },
        }),
      (err: unknown) => err instanceof CliError && /is not empty/.test(err.message),
    );
    assert.equal(readFileSync(path.join(raced, "theirs.txt"), "utf8"), "keep\n");

    const swapped = path.join(base, "swapped");
    const real = path.join(base, "swap-dest");
    await mkdir(real);
    await assert.rejects(
      () =>
        withCreateOnlyTarget(swapped, () => initBundle(swapped, { expectNew: true }), process.cwd(), {
          withFilesystemMutationLockImpl: async (_key, fn) => {
            await symlink(real, swapped);
            return fn();
          },
        }),
      (err: unknown) => err instanceof CliError && /is a symlink/.test(err.message),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a target that disappears after locked observation is uncertainty, never fresh absence", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "disappearing-target");
    let targetLstats = 0;
    let publishCalled = false;
    const logicalTarget = path.resolve(target);
    const physicalTarget = path.join(await fsPromises.realpath(base), "disappearing-target");

    await assert.rejects(
      () =>
        withCreateOnlyTarget(
          target,
          async () => {
            publishCalled = true;
          },
          process.cwd(),
          {
            fs: {
              lstat: async (p) => {
                if (p === logicalTarget) {
                  targetLstats += 1;
                  if (targetLstats === 3) {
                    throw Object.assign(new Error("injected target disappearance"), { code: "ENOENT" });
                  }
                }
                return fsPromises.lstat(p);
              },
            },
          },
        ),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "RUNTIME" &&
        err.details?.phase === "pre-publish" &&
        err.details.operation === "validate-target-presence" &&
        err.details.path === physicalTarget &&
        err.details.fs_code === "ENOENT" &&
        err.details.publication_outcome === "not-started",
    );
    assert.equal(targetLstats, 3);
    assert.equal(publishCalled, false);
    assert.equal(existsSync(path.join(target, "index.md")), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a pre-existing target removed before locked revalidation is not recreated", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "removed-before-lock");
    await mkdir(target);
    let publishCalled = false;
    const physicalTarget = path.join(await fsPromises.realpath(base), "removed-before-lock");

    await assert.rejects(
      () =>
        withCreateOnlyTarget(
          target,
          async () => {
            publishCalled = true;
          },
          process.cwd(),
          {
            withFilesystemMutationLockImpl: async (_key, fn) => {
              await fsPromises.rmdir(target);
              return fn();
            },
          },
        ),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "RUNTIME" &&
        err.details?.phase === "locked-revalidation" &&
        err.details.operation === "compare-target-presence" &&
        err.details.path === physicalTarget &&
        err.details.fs_code === "EPATHCHANGED" &&
        err.details.publication_outcome === "not-started",
    );
    assert.equal(publishCalled, false);
    assert.equal(existsSync(target), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a project-root target holding a conventional workspace is refused BY NAME, not as clutter", async () => {
  const base = await tempDir();
  try {
    const proj = path.join(base, "proj");
    await runInit(["--dir", path.join(proj, ".agentstate-lite"), "--recipe", "none"]);
    const err = await expectRefusal(
      ["--create-only", "--dir", proj],
      /existing project workspace .*\.agentstate-lite already serves this location/,
    );
    assert.equal(err.code, "ALREADY_EXISTS");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a target path running THROUGH an existing file refuses structurally, never a raw fs error", async () => {
  const base = await tempDir();
  try {
    const file = path.join(base, "blocker");
    await writeFile(file, "x\n");
    const err = await expectRefusal(
      ["--create-only", "--dir", path.join(file, "sub", "deep")],
      /runs through an existing file/,
    );
    assert.equal(err.code, "ALREADY_EXISTS");
    assert.match(String(err.help), /recipe add/);
    assert.equal(readFileSync(file, "utf8"), "x\n");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a locked-revalidation index.md racer gets the accurate already-a-bundle refusal", async () => {
  const base = await tempDir();
  try {
    const raced = path.join(base, "raced");
    await assert.rejects(
      () =>
        withCreateOnlyTarget(raced, () => initBundle(raced, { expectNew: true }), process.cwd(), {
          withFilesystemMutationLockImpl: async (_key, fn) => {
            await mkdir(raced);
            await writeFile(path.join(raced, "index.md"), "---\nokf_version: '0.1'\n---\n# raced\n");
            return fn();
          },
        }),
      (err: unknown) => err instanceof CliError && /is already an OKF bundle/.test(err.message),
    );
    assert.equal(existsSync(path.join(raced, "index.md")), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("root-scoped mutex deterministically orders parent/child publication in both directions and shapes", async () => {
  const base = await tempDir();
  try {
    for (const conventional of [false, true]) {
      for (const firstRole of ["parent", "child"] as const) {
        const root = path.join(base, `${conventional ? "conventional" : "ordinary"}-${firstRole}`);
        const parent = path.join(root, "parent");
        const child = conventional
          ? path.join(parent, "deep", "project", ".agentstate-lite")
          : path.join(parent, "deep", "child");
        const attempts: Array<{ role: "parent" | "child"; key: string }> = [];
        const entered: string[] = [];
        let releaseFirst!: () => void;
        const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
        let firstEntered!: () => void;
        const firstCriticalSection = new Promise<void>((resolve) => (firstEntered = resolve));
        let secondAttempted!: () => void;
        const secondLockAttempt = new Promise<void>((resolve) => (secondAttempted = resolve));

        const productionLock = (role: "parent" | "child") =>
          async (
            key: string,
            fn: () => Promise<unknown>,
            options?: Parameters<typeof withFilesystemMutationLock>[2],
          ): Promise<unknown> => {
            attempts.push({ role, key });
            if (role !== firstRole) secondAttempted();
            return withFilesystemMutationLock(
              key,
              async () => {
                entered.push(role);
                if (role === firstRole) {
                  firstEntered();
                  await firstHeld;
                }
                return fn();
              },
              options,
            );
          };
        const run = (role: "parent" | "child", target: string) =>
          withCreateOnlyTarget(
            target,
            (physical) => initBundle(physical, { expectNew: true }),
            process.cwd(),
            { withFilesystemMutationLockImpl: productionLock(role) as typeof withFilesystemMutationLock },
          );

        const firstTarget = firstRole === "parent" ? parent : child;
        const secondRole = firstRole === "parent" ? "child" : "parent";
        const secondTarget = secondRole === "parent" ? parent : child;
        const firstRun = run(firstRole, firstTarget);
        await firstCriticalSection;
        const secondRun = run(secondRole, secondTarget);
        await secondLockAttempt;
        assert.deepEqual(entered, [firstRole], "the second critical section remains blocked");
        assert.equal(attempts.length, 2, "both preflights reached the shared mutex");
        assert.deepEqual(
          attempts.map(({ key }) => key),
          [createOnlyArbitrationLockKey(parent), createOnlyArbitrationLockKey(parent)],
          "both invocations pass the production mutex the shared conservative root key",
        );
        releaseFirst();
        const outcomes = await Promise.allSettled([firstRun, secondRun]);
        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(existsSync(path.join(parent, "index.md")) && existsSync(path.join(child, "index.md")), false);
      }
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("safety regression: a pre-existing empty target is never removed after a create-only failure", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "pre-existing");
    await mkdir(target);
    const before = await fsPromises.lstat(target);
    await assert.rejects(
      () => withCreateOnlyTarget(target, async () => { throw Object.assign(new Error("injected publish fault"), { code: "EIO" }); }),
      (err: unknown) => err instanceof CliError && err.code === "RUNTIME",
    );

    const after = await fsPromises.lstat(target);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.isDirectory(), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("raw publish failures have a truthful started-or-uncertain publication envelope", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "a", "b", "publish-failure");
    const physicalBase = await fsPromises.realpath(base);
    const physicalTarget = path.join(physicalBase, "a", "b", "publish-failure");
    await assert.rejects(
      () =>
        withCreateOnlyTarget(target, async () => {
          throw Object.assign(new Error("injected publish fault"), {
            code: "EIO",
            path: path.join(physicalTarget, "index.md"),
          });
        }),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "RUNTIME" &&
        err.details?.phase === "pre-publish" &&
        err.details.operation === "publish-index" &&
        err.details.path === path.join(physicalTarget, "index.md") &&
        err.details.fs_code === "EIO" &&
        err.details.publication_outcome === "started-or-uncertain" &&
        Array.isArray(err.details.residual_created_directories) &&
        err.details.residual_created_directories.length === 3,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("release failure preserves the masked publish fault's complete structured provenance", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "double-fault");
    const physicalTarget = path.join(await fsPromises.realpath(base), "double-fault");
    const publishPath = path.join(physicalTarget, "index.md");
    const lockPath = path.join(base, "double-fault.lock");
    let thrown: unknown;
    try {
      await withCreateOnlyTarget(
        target,
        async () => {
          throw Object.assign(new Error("injected publish fault"), {
            code: "EIO",
            path: publishPath,
          });
        },
        process.cwd(),
        {
          withFilesystemMutationLockImpl: async (_key, fn) => {
            try {
              return await fn();
            } finally {
              throw new FilesystemMutationLockError("injected release failure", {
                lockPath,
                owner: null,
                stale: false,
                malformed: true,
              });
            }
          },
        },
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof CliError);
    assert.equal(thrown.code, "RUNTIME");
    assert.equal(thrown.details?.phase, "lock");
    assert.equal(thrown.details?.operation, "release-filesystem-mutation-lock");
    assert.equal(thrown.details?.path, lockPath);
    assert.equal(thrown.details?.publication_outcome, "started-or-uncertain");
    assert.equal(thrown.details?.prior_code, "RUNTIME");
    assert.equal(thrown.details?.prior_phase, "pre-publish");
    assert.equal(thrown.details?.prior_operation, "publish-index");
    assert.equal(thrown.details?.prior_path, publishPath);
    assert.equal(thrown.details?.prior_fs_code, "EIO");
    assert.deepEqual(thrown.details?.prior_residual_created_directories, [physicalTarget]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("raw arbitration acquisition failures are typed and publication is not-started", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "raw-lock-failure");
    const lockPath = path.join(base, "raw.lock");
    await assert.rejects(
      () =>
        withCreateOnlyTarget(target, (physical) => initBundle(physical, { expectNew: true }), process.cwd(), {
          withFilesystemMutationLockImpl: async () => {
            throw Object.assign(new Error("injected raw lock failure"), {
              code: "EACCES",
              path: lockPath,
            });
          },
        }),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "RUNTIME" &&
        err.details?.phase === "lock" &&
        err.details.operation === "acquire-filesystem-mutation-lock" &&
        err.details.path === lockPath &&
        err.details.fs_code === "EACCES" &&
        err.details.publication_outcome === "not-started" &&
        Array.isArray(err.details.residual_created_directories) &&
        err.details.residual_created_directories.length === 0,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("safety regression: file, symlink, and directory replacements survive release uncertainty", async () => {
  const base = await tempDir();
  try {
    for (const replacement of ["different-file", "same-bytes-file", "symlink", "directory"] as const) {
      const target = path.join(base, replacement);
      let publishedBytes = "";
      const foreignFile = path.join(base, `${replacement}-foreign`);
      await writeFile(foreignFile, "foreign replacement bytes\n");
      await assert.rejects(
        () =>
          withCreateOnlyTarget(target, (physical) => initBundle(physical, { expectNew: true }), process.cwd(), {
            withFilesystemMutationLockImpl: async (_key, fn) => {
              const value = await fn();
              const index = path.join(target, "index.md");
              publishedBytes = await readFile(index, "utf8");
              await rm(index);
              if (replacement === "different-file") await writeFile(index, "foreign replacement bytes\n");
              if (replacement === "same-bytes-file") await writeFile(index, publishedBytes);
              if (replacement === "symlink") await symlink(foreignFile, index);
              if (replacement === "directory") {
                await mkdir(index);
                await writeFile(path.join(index, "sentinel"), "keep\n");
              }
              throw new FilesystemMutationLockError("injected release uncertainty", {
                lockPath: path.join(base, "injected.lock"),
                owner: null,
                stale: false,
                malformed: true,
              });
            },
          }),
        (err: unknown) =>
          err instanceof CliError &&
          err.code === "RUNTIME" &&
          err.details?.operation === "release-filesystem-mutation-lock" &&
          err.details.publication_outcome === "published",
      );
      const info = await fsPromises.lstat(path.join(target, "index.md"));
      if (replacement === "different-file") assert.equal(await readFile(path.join(target, "index.md"), "utf8"), "foreign replacement bytes\n");
      if (replacement === "same-bytes-file") assert.equal(await readFile(path.join(target, "index.md"), "utf8"), publishedBytes);
      if (replacement === "symlink") assert.equal(info.isSymbolicLink(), true);
      if (replacement === "directory") assert.equal(await readFile(path.join(target, "index.md", "sentinel"), "utf8"), "keep\n");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("any top-level descendant refuses without descending into an unreadable hidden subtree", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "target");
    const opaque = path.join(target, ".opaque", "deep");
    await mkdir(opaque, { recursive: true });
    await writeFile(path.join(opaque, "index.md"), "hidden bytes\n");
    const physicalTarget = path.join(await fsPromises.realpath(base), "target");
    let descended = false;
    await assert.rejects(
      () =>
        assertCreateOnlyTarget(target, process.cwd(), {
          fs: {
            readdir: async (p) => {
              if (p.startsWith(`${physicalTarget}${path.sep}`)) descended = true;
              return fsPromises.readdir(p);
            },
          },
        }),
      (err: unknown) => err instanceof CliError && err.code === "ALREADY_EXISTS" && /is not empty/.test(err.message),
    );
    assert.equal(descended, false);
    assert.equal(await readFile(path.join(opaque, "index.md"), "utf8"), "hidden bytes\n");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("strict create-only observations surface operation, path, and fs code", async (t) => {
  const codes = ["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE", "ENOENT", "ENOTDIR", "ELOOP"];
  for (const code of codes) {
    await t.test(`target readdir ${code}`, async () => {
      const base = await tempDir();
      try {
        const logicalTarget = path.join(base, "target");
        await mkdir(logicalTarget);
        const target = path.join(await fsPromises.realpath(base), "target");
        await assert.rejects(
          () =>
            assertCreateOnlyTarget(target, process.cwd(), {
              fs: { readdir: async () => { throw Object.assign(new Error("injected"), { code }); } },
            }),
          (err: unknown) =>
            err instanceof CliError &&
            err.code === "RUNTIME" &&
            err.details?.operation === "readdir" &&
            err.details.path === target &&
            err.details.fs_code === code,
        );
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  }

  const base = await tempDir();
  try {
    const logicalTarget = path.join(base, "target");
    await mkdir(logicalTarget);
    const physicalBase = await fsPromises.realpath(base);
    const target = path.join(physicalBase, "target");
    const conventional = path.join(target, ".agentstate-lite");
    await mkdir(conventional);
    const upwardConventional = path.join(physicalBase, ".agentstate-lite");
    await mkdir(upwardConventional);
    const binding = path.join(physicalBase, ".agentstate.json");
    await writeFile(binding, `${JSON.stringify({ bundle: path.join(physicalBase, "elsewhere") })}\n`);
    const rows = [
      { operation: "realpath", path: target, deps: { realpath: async () => { throw Object.assign(new Error("injected"), { code: "EIO" }); } } },
      { operation: "lstat", path: target, deps: { lstat: async (p: string) => { if (p === target) throw Object.assign(new Error("injected"), { code: "EIO" }); return fsPromises.lstat(p); } } },
      { operation: "lstat-own-index", path: path.join(target, "index.md"), deps: { lstat: async (p: string) => { if (p === path.join(target, "index.md")) throw Object.assign(new Error("injected"), { code: "EIO" }); return fsPromises.lstat(p); } } },
      { operation: "lstat-conventional-index", path: path.join(conventional, "index.md"), deps: { lstat: async (p: string) => { if (p === path.join(conventional, "index.md")) throw Object.assign(new Error("injected"), { code: "EIO" }); return fsPromises.lstat(p); } } },
      { operation: "lstat-upward-own-index", path: path.join(physicalBase, "index.md"), deps: { readdir: async () => [], lstat: async (p: string) => { if (p === path.join(physicalBase, "index.md")) throw Object.assign(new Error("injected"), { code: "EIO" }); return fsPromises.lstat(p); } } },
      { operation: "lstat-upward-conventional-index", path: path.join(upwardConventional, "index.md"), deps: { readdir: async () => [], lstat: async (p: string) => { if (p === path.join(upwardConventional, "index.md")) throw Object.assign(new Error("injected"), { code: "EIO" }); return fsPromises.lstat(p); } } },
      { operation: "lstat-binding", path: binding, deps: { readdir: async () => [], lstat: async (p: string) => { if (p === binding) throw Object.assign(new Error("injected"), { code: "EIO" }); return fsPromises.lstat(p); } } },
      { operation: "read-binding", path: binding, deps: { readdir: async () => [], readFile: async (p: string) => { if (p === binding) throw Object.assign(new Error("injected"), { code: "EIO" }); return fsPromises.readFile(p, "utf8"); } } },
    ];
    for (const row of rows) {
      await assert.rejects(
        () => assertCreateOnlyTarget(target, process.cwd(), { fs: row.deps }),
        (err: unknown) =>
          err instanceof CliError &&
          err.code === "RUNTIME" &&
          err.details?.operation === row.operation &&
          err.details.path === row.path &&
          err.details.fs_code === "EIO",
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("component-wise creation returns the exact ordered directory receipt and never prunes residue", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "a", "b", "target");
    const physicalBase = await fsPromises.realpath(base);
    const result = await withCreateOnlyTarget(target, (physical) => initBundle(physical, { expectNew: true }));
    assert.deepEqual(result.createdDirectories, [
      path.join(physicalBase, "a"),
      path.join(physicalBase, "a", "b"),
      path.join(physicalBase, "a", "b", "target"),
    ]);
    assert.equal(result.root, path.join(physicalBase, "a", "b", "target"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("arbitration key is shared by parent and child and lock uncertainty is typed", async () => {
  const base = await tempDir();
  try {
    const parent = path.join(base, "parent");
    const child = path.join(parent, "child");
    assert.equal(createOnlyArbitrationLockKey(parent), createOnlyArbitrationLockKey(child));
    for (const details of [
      { owner: null, stale: false, malformed: true },
      { owner: { pid: 999999, hostname: "test", created_at_ms: 1, token: "t", target: "/" }, stale: true, malformed: false },
    ]) {
      await assert.rejects(
        () =>
          withCreateOnlyTarget(parent, (physical) => initBundle(physical, { expectNew: true }), process.cwd(), {
            withFilesystemMutationLockImpl: async () => {
              throw new FilesystemMutationLockError("injected lock refusal", {
                lockPath: path.join(base, "lock"),
                ...details,
              });
            },
          }),
        (err: unknown) =>
          err instanceof CliError &&
          err.code === "RUNTIME" &&
          err.details?.operation === "acquire-filesystem-mutation-lock" &&
          err.details.publication_outcome === "not-started",
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("create-only coordinator contains no product-tree deletion or quarantine operation", async () => {
  const source = await readFile(path.resolve(here, "..", "src", "bundle.ts"), "utf8");
  const coordinator = source.slice(source.indexOf("interface CreateOnlyFilesystem"), source.indexOf("export async function resolveLocalBundleTarget"));
  assert.doesNotMatch(coordinator, /\b(?:unlink|rmdir|rm|rename)\s*\(/);
  assert.equal(coordinator.includes("verifyCreateOnlyIsolation"), false);
});

test("QA F1 (live): simultaneous parent/child create-only processes never both succeed", async () => {
  const { spawn } = await import("node:child_process");
  const base = await tempDir();
  try {
    for (let round = 0; round < 6; round += 1) {
      const parent = path.join(base, `r${round}`, "p");
      const child =
        round % 2 === 0
          ? path.join(base, `r${round}`, "p", "deep", "c")
          : path.join(base, `r${round}`, "p", "deep", "proj", ".agentstate-lite");
      const runOne = (dir: string) =>
        new Promise<number | null>((resolve) => {
          const proc = spawn(
            process.execPath,
            [cliBin, "init", "--create-only", "--dir", dir, "--recipe", "none", "--json"],
            { stdio: "ignore" },
          );
          proc.once("exit", (code) => resolve(code));
        });
      const [parentCode, childCode] = await Promise.all([runOne(parent), runOne(child)]);
      const winners = [parentCode, childCode].filter((code) => code === 0).length;
      assert.ok(winners <= 1, `round ${round}: both succeeded (parent=${parentCode}, child=${childCode})`);
      // Whatever remains on disk must be at most ONE bundle when scanned from the parent root.
      const parentIsBundle = existsSync(path.join(parent, "index.md"));
      const childIsBundle = existsSync(path.join(child, "index.md"));
      assert.ok(!(parentIsBundle && childIsBundle), `round ${round}: nested bundle pair on disk`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("QA F2: a recipe typo fails at exit 2 with NOTHING created; the corrected retry succeeds", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "w");
    let thrown: unknown;
    try {
      await runInit(["--create-only", "--dir", target, "--recipe", "contextnotes"]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof CliError);
    assert.equal(thrown.code, "USAGE");
    assert.match(thrown.message, /unknown recipe 'contextnotes'/);
    assert.equal(existsSync(target), false, "a recipe typo must not create the bundle");
    // The wedge is gone: the corrected retry succeeds on the same target.
    const retry = await runInit(["--create-only", "--dir", target, "--recipe", "context-notes"]);
    assert.equal(retry.init, "ok");
    // Plain init gets the same protection.
    const plain = path.join(base, "w2");
    await assert.rejects(() => runInit(["--dir", plain, "--recipe", "bogus"]));
    assert.equal(existsSync(plain), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a denied target mkdir is structured uncertainty with exact directory residue", async () => {
  const base = await tempDir();
  try {
    const target = path.join(base, "a", "b", "target");
    const physicalBase = await fsPromises.realpath(base);
    let calls = 0;
    await assert.rejects(
      () =>
        withCreateOnlyTarget(target, (physical) => initBundle(physical, { expectNew: true }), process.cwd(), {
          fs: {
            mkdir: async (p) => {
              calls += 1;
              if (calls === 3) throw Object.assign(new Error("injected denial"), { code: "EACCES" });
              await fsPromises.mkdir(p);
            },
          },
        }),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "RUNTIME" &&
        err.details?.operation === "mkdir" &&
        err.details.fs_code === "EACCES" &&
        JSON.stringify(err.details.residual_created_directories) ===
          JSON.stringify([path.join(physicalBase, "a"), path.join(physicalBase, "a", "b")]) &&
        !String(err.help).includes("recipe add"),
    );
    assert.equal(existsSync(path.join(base, "a")), true);
    assert.equal(existsSync(path.join(base, "a", "b")), true);
    assert.equal(existsSync(target), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
