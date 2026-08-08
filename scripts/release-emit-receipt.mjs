// End-of-stage emitter: prints the immutable stage receipt AND the operator's exact interactive
// commands (mandatory pre-approval inspection + reject/approve + the downstream operations) so the
// staged-release run ends with everything a human needs and NOTHING that resumes automatically.
// All command strings come from the ONE pure emitter (scripts/release-operations.mjs).
//
// The workflow supplies the full prepared/draft/staged chain and --json-out stage-receipt.json;
// stdout remains the human-readable step summary.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STABLE_MCP_LAUNCH_GUIDANCE } from "../packages/cli/src/integration-guidance.js";
import {
  inspectionInstructions,
  rejectOperation,
  approveOperation,
  promoteOperation,
  registryVerifyOperations,
} from "./release-operations.mjs";
import { receiptEmissionCommands } from "./release-ordering.mjs";
import { buildStageReceipt } from "./release-receipts.mjs";

const scriptPath = fileURLToPath(import.meta.url);

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
  const { stageId, version, policyTag, tarballSha256, draftReleaseId } = fields;
  const receipt = buildStageReceipt(fields);
  const inspection = inspectionInstructions({ stageId, tarballSha256, version });
  return {
    receipt,
    inspection,
    receipt_emission: receiptEmissionCommands({ stageId, version, draftReleaseId }),
    operations: {
      reject: rejectOperation({ stageId }),
      approve: approveOperation({ stageId }),
      registry_verify: registryVerifyOperations({ version }),
      promote: promoteOperation({ version, tag: policyTag }),
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
    ...STABLE_MCP_LAUNCH_GUIDANCE.split("\n"),
  ];
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const argv = process.argv.slice(2);
  const built = buildReceipt({
    runId: arg(argv, "--run-id"),
    artifactId: arg(argv, "--artifact-id"),
    artifactDigest: arg(argv, "--artifact-digest"),
    stageId: arg(argv, "--stage-id"),
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
