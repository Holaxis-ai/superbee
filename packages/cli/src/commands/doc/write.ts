// `doc write <id>` — see `../doc.ts`'s header comment for the full F1 (P1, data loss) rationale and
// the stdin-detection rule this verb's body-source guard depends on.
import { parseArgs } from "node:util";
import { loadKinds, SUPERBEE_UPDATED_BY_FIELD, type Frontmatter, type OkfDocument } from "@superbee/core";
import { assertResolvedLocalRouteIdentity, boardAttributionForRoute, openBundle, resolveLocalBundleRoute, resolveRemoteFlag } from "../../bundle.js";
import { CliError } from "../../errors.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { render, resolveMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import { mutateDoc } from "../../mutate.js";
import { isLegacyPageDoc, LEGACY_PAGE_TYPE_HINT } from "../../legacy-page.js";
import { boardPostPersistHook } from "../../board-attribution.js";
import { resolveActor } from "../../actor.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import { readExternalTextFile } from "../../external-file.js";
import {
  DOC_WRITE_USAGE,
  type DocCliDeps,
  defaultReadStdin,
  guardDroppedLinks,
  guardTruncatedBodyPreview,
  STDIN_SILENT_NOTE,
  STDIN_SILENT_TIMEOUT,
} from "./common.js";

export async function docWrite(argv: string[], deps: Partial<DocCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const readStdin = deps.readStdin ?? defaultReadStdin;

  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          type: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          resource: { type: "string" },
          tag: { type: "string", multiple: true },
          timestamp: { type: "string" },
          body: { type: "string" },
          "body-file": { type: "string" },
          "blank-body": { type: "boolean" },
          "replace-links": { type: "boolean" },
          "accept-truncated-body": { type: "boolean" },
          strict: { type: "boolean" },
          actor: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.docWrite,
  );
  if (values.help) {
    stdout(DOC_WRITE_USAGE);
    return;
  }

  const rawId = positionals[0]?.trim();
  if (!rawId) {
    throw new CliError("USAGE", "doc write requires a concept <id> positional", {
      help: `${cliInvocation()} doc write <id> --type <t>`,
    });
  }
  let id = conceptIdFromCliArgument(rawId);
  const type = values.type?.trim();
  if (!type) {
    throw new CliError("USAGE", "--type <t> is required (OKF concepts must carry a non-empty type)", {
      help: `${cliInvocation()} doc write ${id} --type <t>`,
    });
  }
  const actor = resolveActor(values.actor, { help: `${cliInvocation()} doc write ${id} --actor <name>` });

  // Body source: --body wins, then --body-file, then piped stdin. `bodySourceGiven` tracks whether
  // the caller supplied a body source at all: --body (even --body "") and --body-file always count,
  // even when their content is empty; piped stdin counts ONLY when its content is non-empty
  // (belt-and-braces: an empty stdin read is treated the same as no input at all, since an agent
  // harness's redirected-but-dataless stdin can otherwise be indistinguishable from a deliberate
  // empty pipe). This is the F1 guard below's load-bearing distinction.
  let body: string;
  let bodySourceGiven: boolean;
  // The probe found a real-but-silent stdin (see STDIN_SILENT_TIMEOUT in common.ts): same "nothing
  // given" body decision as `undefined`, but surfaced as a receipt `note` below — a NEW doc created
  // with an empty body while a slow producer's bytes arrive too late must not be silent.
  let stdinSilentTimeout = false;
  if (values.body !== undefined) {
    body = values.body;
    bodySourceGiven = true;
  } else if (values["body-file"]) {
    body = await readExternalTextFile(values["body-file"]);
    bodySourceGiven = true;
  } else {
    const stdinRead = await readStdin();
    stdinSilentTimeout = stdinRead === STDIN_SILENT_TIMEOUT;
    const stdinBody = typeof stdinRead === "string" ? stdinRead : undefined;
    bodySourceGiven = stdinBody !== undefined && stdinBody !== "";
    body = stdinBody ?? "";
  }
  const blankBody = Boolean(values["blank-body"]);

  const frontmatter: Frontmatter = { type };
  if (values.title !== undefined) frontmatter.title = values.title;
  if (values.description !== undefined) frontmatter.description = values.description;
  if (values.resource !== undefined) frontmatter.resource = values.resource;
  if (values.tag && values.tag.length > 0) frontmatter.tags = values.tag;
  if (values.timestamp?.trim()) {
    // Validate an explicit --timestamp at the input boundary: gate 2 derives freshness/staleness and
    // list-sort from it, so an un-parseable value would silently poison those (it was previously
    // persisted verbatim). Reject with exit 2 like --type does. External-bundle timestamps still flow
    // through the engine's parse-layer normalization untouched — this guards only the CLI's raw input.
    const ts = values.timestamp.trim();
    if (Number.isNaN(Date.parse(ts))) {
      throw new CliError(
        "USAGE",
        `--timestamp ${JSON.stringify(ts)} is not a valid date/time (expected ISO-8601, e.g. 2026-07-03T12:00:00Z)`,
        { help: `${cliInvocation()} doc write ${id} --timestamp <iso>` },
      );
    }
    frontmatter.timestamp = ts;
  }

  const remote = await resolveRemoteFlag(values.remote, values.dir);
  const route = remote === undefined ? await resolveLocalBundleRoute(values.dir) : undefined;
  const bundle = route?.bundle ?? await openBundle(values.dir, remote);
  if (route) await assertResolvedLocalRouteIdentity(route);
  id = await resolveConceptIdCliArgument(bundle, rawId);
  const isConventionPath = id.startsWith("conventions/");

  // `--replace-links` narrows the LINK-DROP guard's own decision ("I accept dropping MY OWN read's
  // links") — it no longer disables the CAS coupling itself (decision: `mutateDoc`'s "overwrite" mode
  // is UNCONDITIONALLY coupled now; see mutate.ts). A full unconditional write is no longer a posture
  // this verb has access to.
  const replaceLinks = Boolean(values["replace-links"]);
  const acceptTruncatedBody = Boolean(values["accept-truncated-body"]);

  // If a kind convention governs `type`, validate against it — WARN-by-default (attach `warnings[]`
  // to the receipt, still write, exit 0); `--strict` upgrades a non-empty warning set to a USAGE
  // error (exit 2) that does NOT write. Core's shared document mutation service runs this decision
  // before writing, defaulting `frontmatter.timestamp` first so a kind that requires
  // `timestamp` validates against the value that will actually be persisted. A conventions-free
  // bundle (no Convention docs) loads an empty registry, so this is a no-op.
  const registry = await loadKinds(bundle);

  // `droppedFields` is set inside `buildCandidate` on the WINNING attempt (mutateDoc's "overwrite"
  // mode calls it once per CAS attempt; the last call before a successful write is the one whose
  // `existing` snapshot actually got replaced) — surfaced on the receipt below.
  let droppedFields: string[] = [];

  // "overwrite" mode: `mutateDoc` re-reads the CURRENT doc (present or absent) immediately before
  // EACH write attempt and hands it to `buildCandidate` as `fresh` — so every read-dependent decision
  // below (schema-loss refusal, F1 body-blank refusal, link-drop guard, dropped-fields) evaluates
  // against a version-matched snapshot on EVERY attempt, never a stale read from before a concurrent
  // writer's change. These guards must not ride a single upfront peek taken before `mutateDoc`
  // runs, because a Convention
  // created concurrently between that peek and the write, or a competing writer filling/racing the
  // body, could slip past a guard that decided from stale bytes). `--replace-links` still means "I
  // accept dropping MY OWN read's links" — it disables ONLY `guardDroppedLinks`'s own check below,
  // never the CAS coupling itself.
  if (route) await assertResolvedLocalRouteIdentity(route);
  const result = await mutateDoc({
    bundle,
    id,
    mode: "overwrite",
    registry,
    remoteUrl: values.remote,
    strict: Boolean(values.strict),
    helpOnKindReject: `${cliInvocation()} kinds`,
    actor,
    persistActor: true,
    compareTimestamp: values.timestamp !== undefined,
    // Board self-attribution (PR C): fires only after a substantive persisted write — never a
    // refused/failed one — and only for the conventional board bundle (see board-attribution.ts).
    onPersisted: boardPostPersistHook(route ? boardAttributionForRoute(route) : { kind: "none" }, actor),
    buildCandidate: (fresh: OkfDocument | undefined, context) => {
      // SCHEMA-LOSS guard (cold-start study #3): `doc write` replaces the WHOLE document and carries
      // only a fixed flag set (type/title/description/resource/tags/timestamp) — it has NO
      // governs/fields flags. Overwriting an existing kind CONVENTION with it silently drops the
      // convention's schema (governs/fields/path), un-declaring its kind with exit 0 and no warning.
      // Refuse.
      if (isConventionPath && fresh && fresh.frontmatter.type === "Convention") {
        const governs =
          typeof fresh.frontmatter.governs === "string" && fresh.frontmatter.governs.trim()
            ? fresh.frontmatter.governs
            : "(unknown)";
        throw new CliError(
          "USAGE",
          `refusing to overwrite kind convention '${id}' with 'doc write' — it replaces the whole document and ` +
            `would drop the convention's schema (governs/fields/path), un-declaring the '${governs}' kind. To change ` +
            `its title/body, use 'doc update' (it preserves the schema). To change the schema fields, use ` +
            `'${cliInvocation()} kind field "${governs}" add/remove <name>' (or edit the convention's markdown frontmatter directly).`,
          { help: `${cliInvocation()} doc update ${id} --title <t>` },
        );
      }

      // F1 (P1, data loss) guard: an existing, non-empty body must not be silently blanked when no
      // body source was given and the caller hasn't opted into blanking (--blank-body). A brand-new
      // doc is always allowed through (an empty body is a valid creation).
      if (!bodySourceGiven && !blankBody && fresh && fresh.body.trim() !== "") {
        throw new CliError(
          "USAGE",
          `'${id}' already has a non-empty body and no body source was given (--body, --body-file, or ` +
            `piped stdin) — refusing to silently blank it. Pass a body source, run ` +
            `'${cliInvocation()} doc update ${id}' to patch other fields while preserving the body, or ` +
            `pass --blank-body to blank it deliberately.`,
          {
            help: `${cliInvocation()} doc update ${id}`,
            details: { existing_body_chars: fresh.body.length },
          },
        );
      }

      // Truncated-preview guard (data loss): a full-body replace over an existing doc must not
      // persist a `doc read` body PREVIEW as though it were the whole body — see
      // `guardTruncatedBodyPreview`'s own comment for the two identities it keys on.
      // `--accept-truncated-body` opts in. Ordered BEFORE the link-drop guard because a preview body
      // also drops links: diagnosing it as a link problem would send the caller to --replace-links,
      // which authorizes the truncation it was supposed to catch. That ordering only helps WHEN THIS
      // GUARD FIRES — a near-preview body matching neither identity (say, the preview slice plus one
      // character) is still only the link guard's concern, and --replace-links authorizes its drop
      // exactly as it always has.
      if (fresh) guardTruncatedBodyPreview(fresh, body, acceptTruncatedBody);

      // Link-drop guard (data loss): a full-body replace over an existing doc must not silently drop
      // outbound cross-links the old body carried — see `guardDroppedLinks`'s own comment for the
      // exact match rule and why a normal read-modify-write never fires it. `--replace-links` opts in.
      if (fresh) guardDroppedLinks(bundle, fresh, body, replaceLinks);

      // Dropped-frontmatter warning (cold-start study r3): `doc write` replaces the WHOLE document, so
      // an overwrite (e.g. re-running the "same" write, expecting idempotency) silently REGRESSES
      // frontmatter fields the existing doc carried that this write didn't re-supply — e.g. a `status`
      // a prior `doc update`/`new` set. Computed fresh on EVERY attempt (never a stale upfront peek),
      // so a competing writer's concurrent field addition is honestly reported too, not misreported
      // from a snapshot the write is about to clobber. (Conventions are REFUSED above; this only
      // reaches ordinary docs / kind instances.)
      droppedFields = fresh
        ? Object.keys(fresh.frontmatter).filter(
            (k) =>
              k !== "timestamp"
              && !(k in frontmatter)
              && !(k === "actor" && actor !== undefined)
              && !(k === SUPERBEE_UPDATED_BY_FIELD && actor !== undefined && context.okfVersion === "0.2"),
          )
        : [];

      return { frontmatter, body };
    },
    errors: {
      staleHead: (err) =>
        new CliError(
          "STALE_HEAD",
          `'${id}' changed concurrently while re-checking outbound links (moved since ${err.expected ?? "absent"}; ` +
            `now ${err.actual ?? "absent"}) — retries exhausted; re-run the write.`,
          { help: `${cliInvocation()} doc read ${id}` },
        ),
    },
  });

  const saved = result.doc;
  const receipt: Record<string, unknown> = {
    doc: "written",
    changed: result.changed,
    id: saved.id,
    type: saved.frontmatter.type,
    timestamp: saved.frontmatter.timestamp ?? null,
    // The content-addressed version token of this write — pass it back as `--expected-version` for a
    // later optimistic doc update/delete (see also `doc history`).
    version: result.version,
  };
  if (result.changed && droppedFields.length > 0) {
    receipt.dropped_fields = droppedFields;
    receipt.note =
      `'doc write' is a FULL replace and dropped ${droppedFields.length} frontmatter field(s) not re-supplied: ` +
      `${droppedFields.join(", ")}. To change fields while preserving the rest (e.g. a status set by 'doc update' ` +
      `or 'new'), use '${cliInvocation()} doc update ${id}' instead.`;
  }
  // ONLY on the silent-timeout path (never for /dev/null-shaped stdin, an explicit --body, or a
  // delivered pipe): the write proceeded with an empty body after fd 0 — a real open pipe — stayed
  // silent past the probe bound. Joined after a dropped-fields note when both apply (both are true).
  if (stdinSilentTimeout) {
    receipt.note = receipt.note ? `${receipt.note}\n${STDIN_SILENT_NOTE}` : STDIN_SILENT_NOTE;
  }
  if (result.warnings.length > 0) receipt.warnings = result.warnings;
  // Legacy-naming nudge (legacy-page.ts): authoring-moment only — never blocks, never on reads.
  if (isLegacyPageDoc(saved.frontmatter)) receipt.hint = LEGACY_PAGE_TYPE_HINT;
  receipt.help = [`${cliInvocation()} doc read ${saved.id}`];

  stdout(render(receipt, resolveMode(values)));
}
