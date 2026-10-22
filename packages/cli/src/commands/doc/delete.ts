import { renderUsage } from "../../output.js";
// `doc delete <id>` — see `../doc.ts`'s header comment; hard-delete, idempotent, non-cascading.
import { parseArgs } from "node:util";
import { pathFromConceptId, isReservedFile } from "@superbee/core";
import { assertResolvedLocalRouteIdentity, boardAttributionForRoute, openBundle, resolveLocalBundleRoute, resolveRemoteFlag } from "../../bundle.js";
import { CliError, classifyBundleError } from "../../errors.js";
import { assertActorAcceptedByBundle, resolveActor } from "../../actor.js";
import { boardPostPersistHook } from "../../board-attribution.js";
import { deleteMutatedDoc } from "../../mutate.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { render, resolveMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import { DOC_DELETE_USAGE, type DocCliDeps } from "./common.js";
import { commandToken } from "../../command-text.js";

export async function docDelete(argv: string[], deps: Partial<DocCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          "expected-version": { type: "string" },
          actor: { type: "string" },
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
    stdout(renderUsage(DOC_DELETE_USAGE));
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
      { help: `${cliInvocation()} doc delete ${commandToken(id)} --expected-version <v>` },
    );
  }

  const remote = await resolveRemoteFlag(values.remote, values.dir);
  const route = remote === undefined ? await resolveLocalBundleRoute(values.dir) : undefined;
  const bundle = route?.bundle ?? await openBundle(values.dir, remote);
  if (route) await assertResolvedLocalRouteIdentity(route);
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
  const actor = resolveActor(values.actor, { help: `${cliInvocation()} doc delete ${commandToken(id)} --actor <name>` });
  try {
    await assertActorAcceptedByBundle(bundle, actor);
  } catch (error) {
    throw classifyBundleError(error, values.remote);
  }
  const onPersisted = boardPostPersistHook(route ? boardAttributionForRoute(route) : { kind: "none" }, actor);

  if (route) await assertResolvedLocalRouteIdentity(route);
  const deleted = await deleteMutatedDoc({
    bundle, id, expectedVersion, remoteUrl: values.remote, onPersisted,
    staleHead: (err) => new CliError(
      "STALE_HEAD",
      `'${id}' has moved since --expected-version ${commandToken(String(err.expected))} was read (current: ` +
        `${err.actual ?? "absent"}) — re-read and retry with the current version.`,
      {
        help: `${cliInvocation()} doc read ${commandToken(id)}`,
        details: { expected: err.expected, actual: err.actual },
      },
    ),
  });

  // AXI P6: deleting an ABSENT id is SUCCESS (deleted:false), never NOT_FOUND — exit 0 either way.
  const receipt: Record<string, unknown> = { doc: "deleted", id, deleted };
  receipt.help = [`${cliInvocation()} list`];
  stdout(render(receipt, mode));
}
