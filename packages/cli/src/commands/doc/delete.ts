// `doc delete <id>` — see `../doc.ts`'s header comment; hard-delete, idempotent, non-cascading.
import { parseArgs } from "node:util";
import { deleteDoc, pathFromConceptId, isReservedFile, VersionConflict } from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../../bundle.js";
import { CliError, classifyBundleError } from "../../errors.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { render, resolveMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import { DOC_DELETE_USAGE, type DocCliDeps } from "./common.js";

export async function docDelete(argv: string[], deps: Partial<DocCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          "expected-version": { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.docDelete,
  );
  if (values.help) {
    stdout(DOC_DELETE_USAGE);
    return;
  }

  const rawId = positionals[0]?.trim();
  if (!rawId) {
    throw new CliError("USAGE", "doc delete requires a concept <id> positional", {
      help: `${cliInvocation()} doc delete <id>`,
    });
  }
  let id = conceptIdFromCliArgument(rawId);

  // Reserved path aliases are decidable without opening a bundle. Keep this guard before any I/O;
  // the distinct canonical id `index.md` is spelled `index.md.md` at the CLI boundary.
  if (isReservedFile(pathFromConceptId(id))) {
    throw new CliError(
      "USAGE",
      `'${id}' is a reserved file (index.md/log.md) — reserved files cannot be deleted.`,
      { help: `${cliInvocation()} doc delete --help` },
    );
  }

  // A PRESENT-but-blank `--expected-version` is a USAGE error, not "no CAS". The seam's own
  // `assertValidExpectedVersion` rejects `""`; coercing a blank flag to `undefined` here would
  // SILENTLY downgrade an intended compare-and-swap into an UNCONDITIONAL delete — the exact
  // lost-update class CAS exists to prevent, on the most destructive operation. A real token
  // never trims to empty; an empty one only comes from a scripting slip (`--expected-version
  // "$VAR"` with an unset `$VAR`), so fail loudly instead of deleting anyway.
  const rawExpected = values["expected-version"];
  if (rawExpected !== undefined && rawExpected.trim() === "") {
    throw new CliError(
      "USAGE",
      "--expected-version was given an empty value — pass a real version token (from a prior read/write receipt) or omit the flag for an unconditional delete.",
      { help: `${cliInvocation()} doc delete ${id} --expected-version <v>` },
    );
  }

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  id = await resolveConceptIdCliArgument(bundle, rawId);

  // Belt-and-suspenders after `.md` ambiguity resolution and any future resolver changes.
  if (isReservedFile(pathFromConceptId(id))) {
    throw new CliError(
      "USAGE",
      `'${id}' is a reserved file (index.md/log.md) — reserved files cannot be deleted.`,
      { help: `${cliInvocation()} doc delete --help` },
    );
  }
  const mode = resolveMode(values);
  const expectedVersion = rawExpected?.trim();

  let deleted: boolean;
  try {
    deleted = await deleteDoc(bundle, id, expectedVersion ? { expectedVersion } : undefined);
  } catch (err) {
    if (err instanceof VersionConflict) {
      throw new CliError(
        "STALE_HEAD",
        `'${id}' has moved since --expected-version ${err.expected} was read (current: ` +
          `${err.actual ?? "absent"}) — re-read and retry with the current version.`,
        {
          help: `${cliInvocation()} doc read ${id}`,
          details: { expected: err.expected, actual: err.actual },
        },
      );
    }
    throw classifyBundleError(err, values.remote);
  }

  // AXI P6: deleting an ABSENT id is SUCCESS (deleted:false), never NOT_FOUND — exit 0 either way.
  const receipt: Record<string, unknown> = { doc: "deleted", id, deleted };
  receipt.help = [`${cliInvocation()} list`];
  stdout(render(receipt, mode));
}
