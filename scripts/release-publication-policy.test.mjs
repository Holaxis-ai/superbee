import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  checkDeclaredDistTags,
  checkUnauthorizedDistTags,
  describeDestiny,
  distTagDestiny,
  eligibleFor,
  mayHoldDistTag,
  registryUrlFor,
} from "./release-publication-policy.mjs";
import { defaultReleaseManifest } from "./release-targets.mjs";

const execFileAsync = promisify(execFile);
const scriptFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-publication-policy.mjs");

const committedManifest = defaultReleaseManifest();
const bridgeTuple = committedManifest.allowed_tuples.bridge;

/**
 * The declared destiny of a tuple, restated INDEPENDENTLY of the implementation: a version lands on
 * `npm_tag` at stage and moves to `npm_promote_tag` at finalize, and those are the only dist-tags it
 * ever carries. Tests compare the implementation against this restatement, so they follow a policy
 * edit instead of pinning today's policy values.
 */
function declaredTagsOf(tuple) {
  return new Set([tuple.publication.npm_tag, tuple.publication.npm_promote_tag].filter((tag) => typeof tag === "string"));
}

/** A synthetic destiny map — the shape `distTagDestiny` produces — for one candidate version. */
function destinyOf(version, tags) {
  return new Map([[version, new Set(tags)]]);
}

// --- the derivation ---------------------------------------------------------------------------

test("distTagDestiny reads the tuple, and an undeclared version stays unconstrained", () => {
  const manifest = {
    allowed_tuples: {
      bridge: { target: "bridge", package: "@holaxis/aslite", version: "0.1.0-pre.11", publication: { npm_tag: "next", npm_promote_tag: null, github_latest: false } },
      stable: { target: "successor-stable", package: "superbee", version: "0.1.0", publication: { npm_tag: "next", npm_promote_tag: "latest", github_latest: true } },
      rehearsal: { target: "rehearsal-reject", package: "superbee-release-rehearsal", version: "0.0.0-x.1", publication: { npm_tag: null, npm_promote_tag: null, github_latest: false } },
    },
  };
  const bridge = distTagDestiny(manifest, "@holaxis/aslite");
  assert.deepEqual([...bridge.get("0.1.0-pre.11")], ["next"], "only the tuple's own package is derived");
  assert.equal(bridge.has("0.1.0"), false);
  assert.equal(mayHoldDistTag(bridge, "0.1.0-pre.11", "latest"), false);
  assert.equal(mayHoldDistTag(bridge, "0.1.0-pre.8", "latest"), true, "a version with no tuple predates the manifest and is unconstrained");
  assert.match(describeDestiny(bridge, "0.1.0-pre.8"), /undeclared/);

  const superbee = distTagDestiny(manifest, "superbee");
  assert.deepEqual([...superbee.get("0.1.0")].sort(), ["latest", "next"]);

  const rehearsal = distTagDestiny(manifest, "superbee-release-rehearsal");
  assert.equal(rehearsal.get("0.0.0-x.1").size, 0, "a non-publishing tuple's version may hold no dist-tag at all");
  assert.equal(mayHoldDistTag(rehearsal, "0.0.0-x.1", "latest"), false);

  assert.deepEqual(
    eligibleFor(bridge, ["0.1.0-pre.8", "0.1.0-pre.11"], "latest"),
    ["0.1.0-pre.8"],
    "eligibility filters the candidate the manifest never promotes",
  );
});

test("the committed manifest's bridge tuple derives exactly the tags it declares", () => {
  const destiny = distTagDestiny(committedManifest, bridgeTuple.package);
  assert.deepEqual([...destiny.get(bridgeTuple.version)].sort(), [...declaredTagsOf(bridgeTuple)].sort());
});

test("the forbidden and required directions are separately decidable", () => {
  const destiny = destinyOf("0.1.0-pre.11", ["next"]);
  assert.deepEqual(
    checkUnauthorizedDistTags({ destiny, version: "0.1.0-pre.11", distTags: { latest: "0.1.0-pre.11", next: "0.1.0-pre.11" } }).map((v) => v.code),
    ["unauthorized_dist_tag"],
  );
  assert.deepEqual(checkUnauthorizedDistTags({ destiny, version: "0.1.0-pre.11", distTags: { latest: "0.1.0-pre.8", next: "0.1.0-pre.11" } }), []);
  assert.deepEqual(
    checkDeclaredDistTags({ destiny, version: "0.1.0-pre.11", distTags: { latest: "0.1.0-pre.8", next: "0.1.0-pre.8" } }).map((v) => [v.code, v.tag]),
    [["declared_dist_tag_unmet", "next"]],
  );
  assert.deepEqual(checkDeclaredDistTags({ destiny, version: "0.1.0-pre.11", distTags: { latest: "0.1.0-pre.8", next: "0.1.0-pre.11" } }), []);
  assert.deepEqual(
    checkDeclaredDistTags({ destiny: new Map(), version: "0.1.0-pre.8", distTags: {} }),
    [],
    "the manifest requires nothing of a version it does not declare",
  );
});

test("registryUrlFor escapes a scoped package the way the registry wants", () => {
  assert.equal(registryUrlFor("@holaxis/aslite"), "https://registry.npmjs.org/@holaxis%2faslite");
  assert.equal(registryUrlFor("superbee"), "https://registry.npmjs.org/superbee");
});

// --- the CLI's exit contract ------------------------------------------------------------------

async function runVerify(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptFile, "verify", ...args], { timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// The live @holaxis/aslite registry as captured 2026-08-14: latest == next == 0.1.0-pre.8 over
// published pre.1, pre.2, pre.3, pre.8 (pre.4..pre.7, pre.9, pre.10 are declared burns).
const LIVE_PUBLISHED = ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.8"];
const LIVE_AT_REST = "0.1.0-pre.8";

function packument(distTags, versions = [...LIVE_PUBLISHED, bridgeTuple.version]) {
  return {
    "dist-tags": distTags,
    versions,
    time: Object.fromEntries(versions.map((v, i) => [v, new Date(Date.UTC(2026, 6, 1 + i)).toISOString()])),
  };
}

/** The dist-tag state the cutover PRODUCES for the bridge, read off the committed manifest. */
function settledDistTags() {
  const declared = declaredTagsOf(bridgeTuple);
  return {
    latest: declared.has("latest") ? bridgeTuple.version : LIVE_AT_REST,
    next: declared.has("next") ? bridgeTuple.version : LIVE_AT_REST,
  };
}

async function replayFile(name, body) {
  const scratch = await mkdtemp(path.join(tmpdir(), "release-publication-policy-"));
  const file = path.join(scratch, name);
  await writeFile(file, JSON.stringify(body));
  return file;
}

const BRIDGE = ["--target", "bridge", "--version", bridgeTuple.version, "--attempts", "1"];
const previewTuple = committedManifest.allowed_tuples["successor-preview"];
const PREVIEW = ["--target", "successor-preview", "--version", previewTuple.version, "--attempts", "1"];

test("CLI: the settled post-cutover registry passes in both modes", async () => {
  const file = await replayFile("settled.json", packument(settledDistTags()));
  for (const mode of ["live", "dry-run"]) {
    const run = await runVerify([...BRIDGE, "--mode", mode, "--registry-json", file]);
    assert.equal(run.code, 0, `${mode}: ${run.stderr}`);
    assert.match(run.stdout, /release-publication-policy: PASS/);
  }
});

test("CLI: a declared dist-tag not yet met is fatal in live and reported in dry-run", async () => {
  const file = await replayFile("unmet.json", packument({ latest: LIVE_AT_REST, next: LIVE_AT_REST }));

  const live = await runVerify([...BRIDGE, "--mode", "live", "--registry-json", file]);
  assert.equal(live.code, 1, live.stderr);
  assert.match(live.stderr, /VIOLATION\[declared_dist_tag_unmet\]/);

  const dry = await runVerify([...BRIDGE, "--mode", "dry-run", "--registry-json", file]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /\[dry-run\] live finalize would require/);
});

test("CLI: the failure names the exact operator command for the tag that is unmet", async () => {
  // Whichever half of the destiny is missing, the operator is told which command produces it — the
  // promote command comes from the operations authority, never from a string built here.
  const declared = [...declaredTagsOf(bridgeTuple)];
  const promoteTag = bridgeTuple.publication.npm_promote_tag;
  const file = await replayFile("none.json", packument({ latest: LIVE_AT_REST, next: LIVE_AT_REST }));
  const run = await runVerify([...BRIDGE, "--mode", "live", "--registry-json", file]);
  assert.equal(run.code, 1);
  for (const tag of declared) {
    if (tag === promoteTag) {
      assert.match(run.stderr, new RegExp(`npm dist-tag add ${bridgeTuple.package}@${bridgeTuple.version.replace(/\./g, "\\.")} ${tag}`));
    } else {
      assert.match(run.stderr, /npm stage approve <stage-id>/);
    }
  }
});

// Bridge now declares both `next` and `latest`, so it forbids nothing and cannot host this
// scenario. successor-preview publishes to `next` and never promotes, so `latest` remains
// unauthorized for it — the tuple this case needs. The guard below is what caught the swap.
test("CLI: an unauthorized dist-tag is fatal in EVERY mode — it is policy, not timing", async () => {
  const forbidden = ["latest", "next"].filter((tag) => !declaredTagsOf(previewTuple).has(tag));
  assert.ok(forbidden.length > 0, "the chosen tuple must forbid at least one dist-tag for this scenario to exist");
  for (const tag of forbidden) {
    const file = await replayFile(`forbidden-${tag}.json`, packument({ ...settledDistTags(), [tag]: previewTuple.version }));
    for (const mode of ["live", "dry-run"]) {
      const run = await runVerify([...PREVIEW, "--mode", mode, "--registry-json", file]);
      assert.equal(run.code, 1, `${mode}/${tag}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /VIOLATION\[unauthorized_dist_tag\]/);
    }
  }
});

test("CLI: an unpublished package is fatal in live and tolerated in dry-run", async () => {
  const file = await replayFile("empty.json", packument({}, []));
  // An empty packument still parses; the declared tags are simply unmet.
  const live = await runVerify([...BRIDGE, "--mode", "live", "--registry-json", file]);
  assert.equal(live.code, 1, live.stderr);
  const dry = await runVerify([...BRIDGE, "--mode", "dry-run", "--registry-json", file]);
  assert.equal(dry.code, 0, dry.stderr);
});

test("CLI: identity mismatches and usage errors are distinct non-zero exits", async () => {
  const file = await replayFile("settled2.json", packument(settledDistTags()));
  const mismatch = await runVerify(["--target", "bridge", "--version", "9.9.9", "--mode", "live", "--registry-json", file, "--attempts", "1"]);
  assert.equal(mismatch.code, 1, mismatch.stderr);
  assert.match(mismatch.stderr, /VIOLATION\[target_version_mismatch\]/);

  const identity = ["--target", "bridge", "--version", bridgeTuple.version];
  for (const args of [
    ["--target", "bridge"],
    ["--version", "0.1.0"],
    [...identity, "--mode", "sideways"],
    [...identity, "--attempts", "0"],
    [...identity, "--delay-ms", "-1"],
    [...identity, "--attempts"],
  ]) {
    const run = await runVerify(args);
    assert.equal(run.code, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /USAGE/);
  }
  const noVerb = await execFileAsync(process.execPath, [scriptFile], { timeout: 30_000 }).then(
    () => ({ code: 0 }),
    (error) => ({ code: error.code, stderr: error.stderr }),
  );
  assert.equal(noVerb.code, 2, "the module refuses to do anything without an explicit verb");
});

test("CLI: an unreachable registry is exit 20 — could NOT evaluate, never 'policy holds'", async () => {
  // Closed loopback port: connection refused is a network condition, structurally distinct from a
  // policy violation, and still fatal to the finalizer because an unevaluated precondition is unmet.
  const run = await runVerify([...BRIDGE, "--mode", "live", "--registry-url", "http://127.0.0.1:1/aslite"]);
  assert.equal(run.code, 20, run.stderr);
  assert.match(run.stderr, /NETWORK:.*could NOT be evaluated/);
});

// --- read-after-write lag: the reason the retry exists -----------------------------------------

/** A registry that serves `stale` for the first `lagResponses` reads, then `fresh`. */
async function laggingRegistry({ stale, fresh, lagResponses }) {
  let served = 0;
  const server = createServer((request, response) => {
    served += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(served <= lagResponses ? stale : fresh));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/aslite`,
    get served() {
      return served;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("CLI: a bounded retry absorbs registry read-after-write lag on the operator's promotion", async () => {
  const registry = await laggingRegistry({
    stale: packument({ latest: LIVE_AT_REST, next: LIVE_AT_REST }),
    fresh: packument(settledDistTags()),
    lagResponses: 2,
  });
  try {
    const run = await runVerify([
      "--target", "bridge", "--version", bridgeTuple.version, "--mode", "live",
      "--registry-url", registry.url, "--attempts", "6", "--delay-ms", "1",
    ]);
    assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /declared dist-tags not visible yet/, "the lag must be reported, not silently absorbed");
    assert.match(run.stdout, /"attempts_used":3/, "it must have taken three reads to see the operator's write");
  } finally {
    await registry.close();
  }
});

test("CLI: exhausting the retry still FAILS CLOSED rather than passing", async () => {
  const registry = await laggingRegistry({
    stale: packument({ latest: LIVE_AT_REST, next: LIVE_AT_REST }),
    fresh: packument(settledDistTags()),
    lagResponses: Number.MAX_SAFE_INTEGER,
  });
  try {
    const run = await runVerify([
      "--target", "bridge", "--version", bridgeTuple.version, "--mode", "live",
      "--registry-url", registry.url, "--attempts", "3", "--delay-ms", "1",
    ]);
    assert.equal(run.code, 1, run.stdout);
    assert.match(run.stderr, /VIOLATION\[declared_dist_tag_unmet\]/);
    assert.equal(registry.served, 3, "every attempt must actually re-read the registry");
  } finally {
    await registry.close();
  }
});

test("CLI: a FORBIDDEN dist-tag is never retried — it is not a timing condition", async () => {
  const forbidden = ["latest", "next"].filter((tag) => !declaredTagsOf(bridgeTuple).has(tag))[0];
  const violating = packument({ ...settledDistTags(), [forbidden]: bridgeTuple.version });
  const registry = await laggingRegistry({ stale: violating, fresh: violating, lagResponses: 0 });
  try {
    const run = await runVerify([
      "--target", "bridge", "--version", bridgeTuple.version, "--mode", "live",
      "--registry-url", registry.url, "--attempts", "6", "--delay-ms", "1",
    ]);
    assert.equal(run.code, 1, run.stdout);
    assert.match(run.stderr, /VIOLATION\[unauthorized_dist_tag\]/);
    assert.equal(registry.served, 1, "a forbidden state must fail on the first read, not after six");
  } finally {
    await registry.close();
  }
});

test("CLI: a transient registry outage is retried, then reported as network — never as policy", async () => {
  let served = 0;
  const server = createServer((request, response) => {
    served += 1;
    if (served <= 2) {
      response.writeHead(503).end("unavailable");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(packument(settledDistTags())));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const run = await runVerify([
      "--target", "bridge", "--version", bridgeTuple.version, "--mode", "live",
      "--registry-url", `http://127.0.0.1:${port}/aslite`, "--attempts", "6", "--delay-ms", "1",
    ]);
    assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /registry unavailable .*retrying/);

    const exhausted = await runVerify([
      "--target", "bridge", "--version", bridgeTuple.version, "--mode", "live",
      "--registry-url", "http://127.0.0.1:1/aslite", "--attempts", "2", "--delay-ms", "1",
    ]);
    assert.equal(exhausted.code, 20, exhausted.stderr);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
