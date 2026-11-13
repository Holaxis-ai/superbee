import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FilesystemBackend } from "@superbee/core";
import * as core from "@superbee/core/qualified-filesystem";
import { inspectQualifiedRoot } from "@superbee/core/qualified-storage";
import { resolveLocalBundleRoute } from "../bundle.js";
import { configuredBundle } from "../filesystem-runtime.js";
import { readExternalTextFileWithin } from "../external-file.js";
import {
  assertBundleOutsidePrivateState,
  assertPathOutsidePrivateState,
} from "../private-state-bundle-boundary.js";
import { CliError } from "../errors.js";

const HELP = `Experimental qualified local bundles (source build only, OKF 0.2 + qualified-kinds/v1).
qualified inspect --input <artifact-v2.json> --actor <actor> [--out <new-approval-draft.json>]
qualified preflight --input <recipe-set-v2.json>
qualified init --dir <empty-dir> --actor <actor>
qualified install --dir <bundle> --input <artifact-v2.json> --approval <approval.json>
qualified kinds --dir <bundle>
qualified local --dir <bundle> --input <local-kind.json> --actor <actor>
qualified new --dir <bundle> --input <record.json> --actor <actor>
qualified read --dir <bundle> --id <id>
qualified update --dir <bundle> --input <patch.json> --actor <actor>
qualified list --dir <bundle> [--selector <selector-from-kinds>]
qualified export --dir <bundle> --out <new-json-file>
qualified import --dir <empty-dir> --input <export.json>

Record input: {"selector":"<from kinds>","id":"decisions/example","fields":{"title":"Example"},"body":"..."}.
Patch input: {"id":"decisions/example","expectedVersion":"<read version>","fields":{"title":"Changed"}}.
Local input: {"kind_id":"my-decision","doc":{"id":"conventions/decision","frontmatter":{"type":"Convention","governs":"Decision","fields":{"required":["reason"]}},"body":""}}.
Derive locally: {"kind_id":"my-variant","from":"<selector>","doc":<optional replacement definition>}.
Approval must independently name repository_id, owner_id, full commit, release, source_revision, actor and approved_at.
Supplying --approval explicitly accepts those pinned coordinates; an artifact's self-claims are not source verification. Acquisition/verification occurs outside this command.
Only these operations are supported. No old-binary interoperability, hosted, board sync, lifecycle, typed links, Views, or legacy conversion. Ordinary commands refuse; inspect/export with this family.
`;
const SUPPORTED = new Set([
  "inspect",
  "preflight",
  "init",
  "install",
  "kinds",
  "local",
  "new",
  "read",
  "update",
  "list",
  "export",
  "import",
]);
export async function guardQualifiedCommand(
  command: string,
  args: string[],
): Promise<void> {
  if (command === "qualified") return;
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: false,
      allowPositionals: true,
      options: { dir: { type: "string" } },
    });
  } catch {
    return;
  } // The command's parser owns malformed-argument diagnostics.
  let route;
  try {
    route = await resolveLocalBundleRoute(
      typeof parsed.values.dir === "string" ? parsed.values.dir : undefined,
    );
  } catch {
    return;
  }
  if (await inspectQualifiedRoot(route.bundle.backend!))
    throw new CliError(
      "USAGE",
      `Qualified bundle does not support '${command}'.`,
      {
        help: "Use superbee qualified --help; discovery: superbee qualified kinds --dir <bundle>.",
      },
    );
}
async function json(file: string | undefined): Promise<any> {
  if (!file) throw new CliError("USAGE", "--input/--approval file is required");
  const value = await readExternalTextFileWithin(file, 8 * 1024 * 1024);
  if (value === null)
    throw new CliError("USAGE", "Qualified input exceeds 8 MiB");
  return JSON.parse(value);
}
export async function qualified(args: string[]): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args,
        allowPositionals: true,
        options: {
          dir: { type: "string" },
          input: { type: "string" },
          approval: { type: "string" },
          out: { type: "string" },
          actor: { type: "string" },
          id: { type: "string" },
          selector: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    CLI_LEAVES.qualified,
  );
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const operation = positionals[0];
  if (!operation || !SUPPORTED.has(operation))
    throw new CliError(
      "USAGE",
      "Supply a supported qualified operation; run qualified --help",
    );
  if (operation === "inspect") {
    if (!values.actor)
      throw new CliError("USAGE", "--actor is required for the approval draft");
    const result = core.inspectQualifiedArtifact(
      await json(values.input),
      values.actor,
    );
    if (values.out) {
      assertPathOutsidePrivateState(path.resolve(values.out));
      await fs.writeFile(
        values.out,
        JSON.stringify(result.approval_draft, null, 2) + "\n",
        { flag: "wx" },
      );
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (operation === "preflight") {
    const result = core.preflightRecipeSetV2(await json(values.input));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.valid) process.exitCode = 2;
    return;
  }
  if (!values.dir) throw new CliError("USAGE", "--dir is required");
  const root = path.resolve(values.dir);
  assertBundleOutsidePrivateState(root);
  const backend = configuredBundle(root).backend;
  if (!(backend instanceof FilesystemBackend))
    throw new CliError(
      "USAGE",
      "Qualified operations require the local filesystem backend",
    );
  if (["init", "local", "new", "update"].includes(operation) && !values.actor)
    throw new CliError("USAGE", "--actor is required");
  let result: unknown;
  switch (operation) {
    case "init":
      result = await core.initializeQualifiedBundle(backend, {
        actor: values.actor!,
      });
      break;
    case "install":
      result = await core.installQualifiedRecipes(backend, [
        {
          artifact: await json(values.input),
          approval: await json(values.approval),
        },
      ]);
      break;
    case "kinds":
      result = await core.qualifiedKinds(backend);
      break;
    case "local":
      result = await core.addLocalQualifiedKind(backend, {
        ...(await json(values.input)),
        actor: values.actor!,
      });
      break;
    case "new":
      result = await core.createQualifiedDocument(backend, {
        ...(await json(values.input)),
        actor: values.actor!,
      });
      break;
    case "read":
      if (!values.id) throw new CliError("USAGE", "--id is required");
      result = await core.readQualifiedDocument(backend, values.id);
      break;
    case "update":
      result = await core.updateQualifiedDocument(backend, {
        ...(await json(values.input)),
        actor: values.actor!,
      });
      break;
    case "list":
      result = await core.listQualifiedDocuments(backend, values.selector);
      break;
    case "export": {
      if (!values.out) throw new CliError("USAGE", "--out is required");
      assertPathOutsidePrivateState(path.resolve(values.out));
      const portable = await core.exportQualifiedBundle(backend);
      await fs.writeFile(values.out, JSON.stringify(portable, null, 2) + "\n", {
        flag: "wx",
      });
      result = { exported: values.out };
      break;
    }
    case "import":
      result = await core.importQualifiedBundle(
        backend,
        await json(values.input),
      );
      break;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
