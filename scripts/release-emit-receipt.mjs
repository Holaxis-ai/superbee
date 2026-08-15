// End-of-stage emitter: prints the immutable stage receipt AND the operator's exact interactive
// commands (mandatory pre-approval inspection + reject/approve + the downstream operations) so the
// staged-release run ends with everything a human needs and NOTHING that resumes automatically.
// All command strings come from the ONE pure emitter (scripts/release-operations.mjs).
//
// The workflow supplies the full prepared/draft/staged chain and --json-out stage-receipt.json;
// stdout remains the human-readable step summary.
import { writeFile } from "node:fs/promises";
import { STABLE_MCP_LAUNCH_GUIDANCE } from "../packages/cli/src/integration-guidance.js";
import { isMainModule } from "./is-main-module.mjs";
import {
  inspectionInstructions,
  rejectOperation,
  approveOperation,
  promoteOperationForTarget,
  registryVerifyOperations,
} from "./release-operations.mjs";
import { receiptEmissionCommands } from "./release-ordering.mjs";
import { buildStageReceipt } from "./release-receipts.mjs";

function arg(argv, flag, required = true) {
  const at = argv.indexOf(flag);
  if (at === -1) {
    if (required) throw new Error(`missing ${flag}`);
    return undefined;
  }
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
  return value;
}

export function buildReceipt(fields) {
  const { stageId, version, tarballSha256, draftReleaseId } = fields;
  const receipt = buildStageReceipt(fields);
  // The receipt's own resolver is the ONE authority for which package this stage mutates, and it
  // requires an explicit target (or an unambiguous package name). Every operator command below is
  // built from the id it resolved, so a missing target can no longer produce a bridge-shaped
  // receipt - bridge tarball filenames, bridge registry-verify - for a superbee stage.
  const target = receipt.prepared.target;
  const inspection = inspectionInstructions({ stageId, tarballSha256, version, target });
  // `publication.npm_promote_tag` may be null (bridge, preview, rehearsal): then there is no
  // promotion to perform and the receipt carries no promote operation at all.
  const promote = promoteOperationForTarget({ version, target });
  return {
    receipt,
    inspection,
    receipt_emission: receiptEmissionCommands({ stageId, version, draftReleaseId }),
    operations: {
      reject: rejectOperation({ stageId }),
      approve: approveOperation({ stageId }),
      registry_verify: registryVerifyOperations({ version, target }),
      ...(promote ? { promote } : {}),
      // The immutable-release (draft publish) operation is emitted later by the finalize workflow,
      // once a real draft release id exists — not premature at stage time with a placeholder.
    },
  };
}

export function renderReceiptMarkdown(built) {
  const { receipt, inspection, receipt_emission: emission, operations } = built;
  const lines = [
    "## Staged release receipt",
    "",
    "```json",
    JSON.stringify(receipt, null, 2),
    "```",
    "",
    `### ${inspection.title} (REQUIRED before approval)`,
    "",
    "One command downloads the stage, verifies the SHA, and uploads your SIGNED inspection",
    "receipt (the finalize ordering gate consumes it; stable candidates REQUIRE it):",
    "",
    "```sh",
    emission.inspected,
    "```",
    "",
    "Manual fallback (emits no receipt — run the tool afterwards):",
    "",
    "```sh",
    ...inspection.steps,
    "```",
    `- Expected SHA-256: \`${inspection.expected_sha256}\``,
    `- On mismatch: ${inspection.on_mismatch}`,
    "",
    "### After a MATCHING inspection",
    "",
    "```sh",
    `# reject (spends this stage; prepare the next SemVer):`,
    operations.reject.command,
    `# or approve (requires 2FA):`,
    operations.approve.command,
    `# then upload the SIGNED approval receipt:`,
    emission.approved,
    "```",
    "",
    "### Registry verification (read-only, after approval)",
    "",
    "```sh",
    ...operations.registry_verify.commands,
    operations.registry_verify.workflow_proof,
    "```",
    "",
    // Promotion is an OPERATOR action: npm 11.15 trusted publishing is publish-scoped, so no
    // workflow holds a credential for `npm dist-tag add`. This is the only instruction the operator
    // gets for it, and it is built from the tuple's npm_promote_tag — the declared end state the
    // release is checked against — so following it verbatim reaches exactly that state.
    ...(operations.promote
      ? [
        "### Promotion (REQUIRED operator action — no workflow performs this)",
        "",
        "npm 11.15 trusted publishing is publish-scoped: `npm dist-tag add` exchanges no OIDC token, so",
        "nothing promotes on your behalf. After the registry verification above, run this yourself",
        "(requires 2FA). The release is not complete until the registry carries this tag:",
        "",
        "```sh",
        operations.promote.command,
        "```",
      ]
      : [
        "### Promotion (none for this release)",
        "",
        "This release tuple declares no dist-tag promotion (`npm_promote_tag: null`): the tag npm",
        "already carries is final. No workflow promotes it and neither should you — do NOT move a",
        "dist-tag by hand.",
      ]),
    "",
    ...STABLE_MCP_LAUNCH_GUIDANCE.split("\n"),
  ];
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const built = buildReceipt({
    runId: arg(argv, "--run-id"),
    artifactId: arg(argv, "--artifact-id"),
    artifactDigest: arg(argv, "--artifact-digest"),
    stageId: arg(argv, "--stage-id"),
    // Required: the target decides which package the emitted receipt and operator commands name.
    target: arg(argv, "--target"),
    version: arg(argv, "--version"),
    tag: arg(argv, "--tag"),
    sourceCommit: arg(argv, "--source-commit"),
    policyTag: arg(argv, "--policy-tag"),
    tarballSha256: arg(argv, "--tarball-sha256"),
    tarballFilename: arg(argv, "--tarball-filename"),
    integrity: arg(argv, "--integrity"),
    manifestSha256: arg(argv, "--manifest-sha256"),
    draftReleaseId: arg(argv, "--draft-release-id"),
    draftAssets: JSON.parse(arg(argv, "--draft-assets-json")),
  });
  const jsonOut = arg(argv, "--json-out", false);
  if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(built.receipt, null, 2)}\n`);
  console.log(renderReceiptMarkdown(built));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
