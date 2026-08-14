// Workflow-facing adapter around the pure immutable-receipt validators. This script deliberately
// accepts values as argv/file data only; GitHub expressions are first bound to env values and then
// passed as quoted argv by the workflows, preventing expression-to-shell script injection.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fileSha256 } from "./verify-npm-package.mjs";
import { parseAuxiliaryReleaseAssetName } from "./release-ordering.mjs";
import { parseStagePublishJson, verifyFinalizerChain } from "./release-receipts.mjs";
import { assertWorkflowContract, defaultReleaseTargets, tarballFilename } from "./release-targets.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function arg(argv, flag) {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing ${flag}`);
  return value;
}

async function jsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function captureDraft(argv) {
  const release = await jsonFile(arg(argv, "--release"));
  const tag = arg(argv, "--tag");
  const tarball = arg(argv, "--tarball");
  const manifest = arg(argv, "--manifest");
  if (release.draft !== true) throw new Error(`release ${release.id} is not an unpublished draft`);
  if (release.tag_name !== tag) throw new Error(`draft tag ${release.tag_name} != ${tag}`);
  // A reused draft (rejected-N version reuse) may still carry receipt assets from a rejected
  // sibling stage; those are the ordering gate's concern — the core capture stays exactly two.
  const coreAssets = (Array.isArray(release.assets) ? release.assets : []).filter(
    (asset) => !parseAuxiliaryReleaseAssetName(asset?.name, { mode: "pre-stage" }),
  );
  if (coreAssets.length !== 2) {
    throw new Error(`draft must contain exactly the retained tarball and candidate.json; found ${coreAssets.length}`);
  }
  const expected = new Map([
    [path.basename(tarball), await fileSha256(tarball)],
    ["candidate.json", await fileSha256(manifest)],
  ]);
  const assets = coreAssets
    .map((asset) => ({ id: String(asset.id), name: asset.name, digest: asset.digest }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const asset of assets) {
    const digest = expected.get(asset.name);
    if (!digest) throw new Error(`unexpected draft asset ${asset.name}`);
    if (asset.digest !== digest) throw new Error(`draft asset ${asset.name} digest ${asset.digest} != retained ${digest}`);
    expected.delete(asset.name);
  }
  if (expected.size !== 0) throw new Error(`draft is missing ${[...expected.keys()].join(", ")}`);

  const output = arg(argv, "--github-output");
  await appendFile(output, `release_id=${release.id}\nassets_json=${JSON.stringify(assets)}\n`);
}

async function verifyChain(argv) {
  const candidatePath = arg(argv, "--candidate");
  const receiptPath = arg(argv, "--receipt");
  const candidate = await jsonFile(candidatePath);
  const receipt = await jsonFile(receiptPath);
  const target = defaultReleaseTargets()[candidate.target ?? receipt.prepared?.target ?? "bridge"];
  if (!target) throw new Error(`unknown release target ${JSON.stringify(candidate.target ?? receipt.prepared?.target)}`);
  const expectedFilename = tarballFilename(assertWorkflowContract(target), candidate.version);
  if (candidate.tarball?.filename !== expectedFilename || path.basename(candidate.tarball.filename) !== candidate.tarball.filename) {
    throw new Error(`candidate tarball filename ${candidate.tarball?.filename} != ${expectedFilename}`);
  }
  const tarball = path.join(path.dirname(candidatePath), candidate.tarball.filename);
  const proof = verifyFinalizerChain({
    candidate,
    receipt,
    candidateArtifact: await jsonFile(arg(argv, "--candidate-artifact")),
    receiptArtifact: await jsonFile(arg(argv, "--receipt-artifact")),
    release: await jsonFile(arg(argv, "--release")),
    dispatch: {
      runId: arg(argv, "--run-id"),
      artifactId: arg(argv, "--artifact-id"),
      stageReceiptArtifactId: arg(argv, "--stage-receipt-artifact-id"),
      stageReceiptArtifactDigest: arg(argv, "--stage-receipt-artifact-digest"),
      stageId: arg(argv, "--stage-id"),
      draftReleaseId: arg(argv, "--draft-release-id"),
      version: arg(argv, "--version"),
    },
    actualTarballSha256: await fileSha256(tarball),
    actualManifestSha256: await fileSha256(candidatePath),
  });
  await writeFile(arg(argv, "--out"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "stage-id") {
    console.log(parseStagePublishJson(await readFile(arg(rest, "--file"), "utf8")));
    return;
  }
  if (command === "capture-draft") return captureDraft(rest);
  if (command === "verify-finalizer") return verifyChain(rest);
  throw new Error("usage: release-verify-chain.mjs stage-id|capture-draft|verify-finalizer ...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
