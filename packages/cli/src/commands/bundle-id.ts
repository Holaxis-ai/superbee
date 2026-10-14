// `superbee bundle id set <id>` — declare this bundle's portable id: `bundle_id` in `docs/bundle`
// under the `Bundle Name` marker type, the field core's `declaredBundleId` reads.
import { parseArgs } from "node:util";
import {
  BUNDLE_NAME_DOC_ID,
  BUNDLE_NAME_DOC_TYPE,
  isHostedBundleId,
  loadKinds,
} from "@superbee/core";

import { resolveActor } from "../actor.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandToken } from "../command-text.js";
import {
  DECLARATION_COMMON_OPTIONS,
  declarationErrorHooks,
  declarationPersistHook,
  expectedVersionFlag,
  givenFlags,
  openDeclarationTarget,
} from "../declaration-writes.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { mutateDoc } from "../mutate.js";
import { render, renderUsage, resolveMode } from "../output.js";

export const BUNDLE_ID_SET_USAGE = `superbee bundle id set — declare this bundle's portable id

Usage:
  superbee bundle id set <id> [--force] [--expected-version <v>] [--actor <name>] [--dir <path> | --remote <url>]

Writes bundle_id into docs/bundle, the document a bundle names itself in. Another bundle's
docs/dependencies names this bundle by that id, and 'status --with' checks the two agree.

<id> is lower-case letters and digits joined by '.', '_' or '-', starting with a letter, at most
128 characters (the hosted bundle-id rule).

docs/bundle is created (type '${BUNDLE_NAME_DOC_TYPE}') when missing. An existing docs/bundle keeps
its title, name, body and every other field; only bundle_id changes. A docs/bundle of another type
is not this bundle's name document and is refused (CONFLICT). Setting the id it already has is a
no-op (changed:false). Changing a different existing id is refused (CONFLICT) unless --force is
given: links other bundles resolve against the old id stop resolving.

The document is re-serialized on write: YAML comments and formatting in its frontmatter are not
preserved.

Options:
  --force                 Replace a different existing bundle_id
${DECLARATION_COMMON_OPTIONS}
`;

const USAGE_HELP = `${cliInvocation()} bundle id set --help`;

export async function bundleId(argv: string[], stdout: (s: string) => void): Promise<void> {
  if (argv[0] !== "set") {
    if (argv[0] === undefined || argv[0] === "-h" || argv[0] === "--help") {
      stdout(renderUsage(BUNDLE_ID_SET_USAGE));
      return;
    }
    throw new CliError("USAGE", `unknown bundle id subcommand: ${argv[0]} (expected set)`, { help: USAGE_HELP });
  }
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv.slice(1),
        options: {
          force: { type: "boolean" },
          "expected-version": { type: "string" },
          actor: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.bundleIdSet,
  );
  if (values.help) {
    stdout(renderUsage(BUNDLE_ID_SET_USAGE));
    return;
  }

  const id = positionals[0]!.trim();
  if (!isHostedBundleId(id)) {
    throw new CliError(
      "USAGE",
      `'${id}' is not a portable bundle id: use lower-case letters and digits joined by '.', '_' or '-', starting with a letter, at most 128 characters`,
      { help: USAGE_HELP, details: { reason: "BUNDLE_ID", bundle_id: id } },
    );
  }
  const retry = `${cliInvocation()} bundle id set ${commandToken(id)}`;
  const rerun = `${retry}${givenFlags([["force", values.force], ["actor", values.actor], ["dir", values.dir], ["remote", values.remote]])}`;
  const expectedVersion = expectedVersionFlag(values["expected-version"], `${retry} --expected-version <v>`);
  const actor = resolveActor(values.actor, { help: `${retry} --actor <name>` });
  const target = await openDeclarationTarget(values.dir, values.remote);

  let created = false;
  let previous: unknown = null;
  const result = await mutateDoc({
    bundle: target.bundle,
    id: BUNDLE_NAME_DOC_ID,
    mode: "patch",
    onAbsent: "create",
    registry: await loadKinds(target.bundle),
    strict: false,
    helpOnKindReject: `${cliInvocation()} kinds`,
    remoteUrl: target.remoteUrl,
    actor,
    persistActor: true,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    onPersisted: declarationPersistHook(target, actor),
    buildCandidate: (existing) => {
      created = existing === undefined;
      previous = existing?.frontmatter.bundle_id ?? null;
      if (!existing) return { frontmatter: { type: BUNDLE_NAME_DOC_TYPE, bundle_id: id }, body: "" };
      const type = existing.frontmatter.type;
      if (typeof type !== "string" || type.trim() !== BUNDLE_NAME_DOC_TYPE) {
        throw new CliError(
          "CONFLICT",
          `${BUNDLE_NAME_DOC_ID} exists with type ${JSON.stringify(type ?? null)}, so it does not name this bundle; ` +
            `give it type '${BUNDLE_NAME_DOC_TYPE}' (${cliInvocation()} doc update ${BUNDLE_NAME_DOC_ID} --type ${commandToken(BUNDLE_NAME_DOC_TYPE)}) or move it, then retry`,
          { help: `${cliInvocation()} doc read ${BUNDLE_NAME_DOC_ID}`, details: { reason: "BUNDLE_DOC_TYPE", type: type ?? null } },
        );
      }
      if (previous !== null && previous !== id && !values.force) {
        throw new CliError(
          "CONFLICT",
          `this bundle already declares bundle_id ${JSON.stringify(previous)}; links other bundles resolve against it stop resolving if it changes. Pass --force to replace it`,
          { help: `${retry} --force`, details: { reason: "BUNDLE_ID_DIFFERS", current: previous, requested: id } },
        );
      }
      return { frontmatter: { ...existing.frontmatter, bundle_id: id }, body: existing.body };
    },
    errors: declarationErrorHooks(BUNDLE_NAME_DOC_ID, { expectedVersion, retry: rerun }),
  });

  const receipt: Record<string, unknown> = {
    bundle_id: id,
    doc: BUNDLE_NAME_DOC_ID,
    result: !result.changed ? "unchanged" : created ? "created" : "updated",
    previous: result.changed && !created ? previous : null,
    changed: result.changed,
    version: result.version,
  };
  if (result.warnings.length > 0) receipt.warnings = result.warnings;
  receipt.help = [`${cliInvocation()} doc read ${BUNDLE_NAME_DOC_ID}`];
  stdout(render(receipt, resolveMode(values)));
}
