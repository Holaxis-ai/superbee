// `doc verify <id>` — append one OKF v0.2 verification event (`verified[]: { by, at }`) naming the
// resolved actor as the verifier, and report the derived trust tier (SPEC 5.2, 5.3).
//
// Verification is deliberately NOT a content change: the body and `generated` are preserved, so
// `generated.at` never advances and `generated.by` is never replaced by a verifier. Core's
// meaningful-change comparator already excludes `verified` from that judgment; this verb relies on
// it rather than re-deriving it. Storage attribution (`superbee_updated_by`) still records who
// wrote the revision, exactly as `doc update` does.
import { parseArgs } from "node:util";
import {
  isOkfActor,
  latestVerifiedAt,
  parseIsoInstant,
  readBundleOkfVersion,
  loadKinds,
  trustTier,
  verificationEvents,
} from "@superbee/core";
import {
  assertResolvedLocalRouteIdentity,
  boardAttributionForRoute,
  openBundle,
  resolveLocalBundleRoute,
  resolveRemoteFlag,
} from "../../bundle.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { CliError } from "../../errors.js";
import { render, resolveMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import { mutateDoc } from "../../mutate.js";
import { boardPostPersistHook } from "../../board-attribution.js";
import { resolveActor } from "../../actor.js";
import { actorRefusal } from "../../actor-guidance.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import { DOC_VERIFY_USAGE, type DocCliDeps } from "./common.js";
import { commandToken } from "../../command-text.js";

export async function docVerify(argv: string[], deps: Partial<DocCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          at: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          "expected-version": { type: "string" },
          actor: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.docVerify,
  );
  if (values.help) {
    stdout(DOC_VERIFY_USAGE);
    return;
  }

  const rawId = positionals[0]?.trim();
  if (!rawId) {
    throw new CliError("USAGE", "doc verify requires a concept <id> positional", {
      help: `${cliInvocation()} doc verify <id> --actor human:<id>`,
    });
  }
  let id = conceptIdFromCliArgument(rawId);
  const actorHelp = `${cliInvocation()} doc verify ${commandToken(id)} --actor human:<id>`;

  // Same guard as `doc update`/`doc delete`: a PRESENT-but-blank token is a USAGE error, never a
  // silent downgrade from compare-and-swap to a retrying write.
  const expectedVersion = values["expected-version"];
  if (expectedVersion !== undefined && expectedVersion.trim() === "") {
    throw new CliError(
      "USAGE",
      "--expected-version was given an empty value — pass a real version token (from a prior read/write receipt) or omit the flag for a normal (retrying) verification.",
      { help: `${cliInvocation()} doc verify ${commandToken(id)} --expected-version <v>` },
    );
  }

  // The verifier IS the resolved actor. Unlike every other verb, an unattributed verification has
  // no meaning (there is nobody to record), so the absence is a refusal rather than a fallback.
  const actor = resolveActor(values.actor, { help: actorHelp });
  if (actor === undefined) {
    throw new CliError(
      "USAGE",
      "doc verify records the resolved actor as the verifier — pass --actor <actor> or set SUPERBEE_ACTOR.",
      { help: actorHelp },
    );
  }

  let at = new Date().toISOString();
  if (values.at !== undefined) {
    // An instant, not a wall-clock reading: without a zone designator the same command would record
    // a different instant on every host (and defeat the identical-event no-op), so `Z` or an
    // explicit offset is required and the value is normalized to UTC.
    // Core's strict parser, not Date.parse: an impossible calendar date (2026-02-30) must be
    // refused, never rolled forward into an instant the caller did not supply.
    const raw = values.at.trim();
    const ms = parseIsoInstant(raw);
    if (ms === null) {
      throw new CliError(
        "USAGE",
        "--at must be a real ISO-8601 date-time WITH a timezone designator (e.g. 2026-09-07T12:00:00Z or 2026-09-07T14:00:00+02:00); a date-only, zone-less, or impossible calendar value is refused",
        { help: `${cliInvocation()} doc verify ${commandToken(id)} --actor ${commandToken(actor)} --at <iso-8601>` },
      );
    }
    at = new Date(ms).toISOString();
  }

  const remote = await resolveRemoteFlag(values.remote, values.dir);
  const route = remote === undefined ? await resolveLocalBundleRoute(values.dir) : undefined;
  const bundle = route?.bundle ?? await openBundle(values.dir, remote);
  if (route) await assertResolvedLocalRouteIdentity(route);
  id = await resolveConceptIdCliArgument(bundle, rawId);
  const mode = resolveMode(values);

  // `verified` is an OKF v0.2 trust family (SPEC 5.2). A v0.1 bundle records free-form actors
  // that no consumer can classify, so a verification there would be a signal nobody can read.
  const okfVersion = (await readBundleOkfVersion(bundle)) ?? "0.1";
  if (okfVersion !== "0.2") {
    throw new CliError(
      "USAGE",
      `doc verify records OKF v0.2 trust metadata; this bundle declares OKF ${okfVersion}. Verification events and trust tiers are not defined for that edition.`,
      { help: `${cliInvocation()} status --dir <path>` },
    );
  }

  // After the edition check, so a v0.1 bundle is told about the edition rather than "this v0.2
  // bundle refuses". Human-first: for a verifier the human reading is the one that changes the tier.
  if (!isOkfActor(actor)) {
    const refusal = actorRefusal(actor, { preferHuman: true });
    throw new CliError("USAGE", `verifier ${refusal.message.replace(/^actor /, "")} Trust tiers key off the human: prefix.`, {
      help: refusal.help,
      details: { actor },
    });
  }

  const registry = await loadKinds(bundle);
  if (route) await assertResolvedLocalRouteIdentity(route);
  const result = await mutateDoc({
    bundle,
    id,
    mode: "patch",
    onAbsent: "fail",
    registry,
    remoteUrl: values.remote,
    strict: false,
    helpOnKindReject: `${cliInvocation()} kinds`,
    actor,
    persistActor: true,
    expectedVersion: expectedVersion?.trim(),
    // No body-replace posture: the body is handed back untouched on every attempt.
    onPersisted: boardPostPersistHook(route ? boardAttributionForRoute(route) : { kind: "none" }, actor),
    input: { kind: "verify", event: { by: actor, at } },
    errors: {
      notFound: () =>
        new CliError("NOT_FOUND", `no concept document at id '${id}'`, { help: `${cliInvocation()} list` }),
      staleHead: (err) =>
        new CliError(
          "STALE_HEAD",
          `'${id}' has moved since --expected-version ${commandToken(String(err.expected))} was read (current: ` +
            `${err.actual ?? "absent"}) — re-read and retry with the current version.`,
          { help: `${cliInvocation()} doc read ${commandToken(id)}`, details: { expected: err.expected, actual: err.actual } },
        ),
    },
  });

  const events = verificationEvents(result.doc.frontmatter);
  const latest = latestVerifiedAt(events);
  const receipt: Record<string, unknown> = {
    doc: "verified",
    id: result.doc.id,
    type: result.doc.frontmatter.type,
    trust: trustTier(result.doc.frontmatter),
    verified: { count: events.length, ...(latest === undefined ? {} : { latest_at: latest }) },
    changed: result.changed,
    version: result.version,
  };
  if (result.warnings.length > 0) receipt.warnings = result.warnings;
  receipt.help = [`${cliInvocation()} doc read ${commandToken(result.doc.id)}`];
  stdout(render(receipt, mode));
}
