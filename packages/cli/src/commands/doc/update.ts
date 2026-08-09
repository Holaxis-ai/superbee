// `doc update <id>` — the field-level PATCH verb; see `../doc.ts`'s header comment for the full
// rationale (Fork 1/Fork 2 of `plans/kind-aware-doc-surface.md`).
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { loadKinds, type Frontmatter } from "@agentstate-lite/core";
import { openBundle, resolveRemoteFlag } from "../../bundle.js";
import { deferArity, parseOrUsage } from "../../args.js";
import { assertLeafArity } from "../../positional-arity.js";
import { CliError } from "../../errors.js";
import { render, resolveMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import { mutateDoc } from "../../mutate.js";
import { isLegacyPageDoc, LEGACY_PAGE_TYPE_HINT } from "../../legacy-page.js";
import { boardPostPersistHook } from "../../board-attribution.js";
import { resolveActor } from "../../actor.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import {
  DOC_UPDATE_USAGE,
  type DocCliDeps,
  defaultReadStdin,
  guardDroppedLinks,
  STDIN_SILENT_NOTE,
  STDIN_SILENT_TIMEOUT,
} from "./common.js";

/** The `doc update` STANDARD patch fields; excludes control flags (--keep-timestamp/--strict/--dir/--remote/…). */
const DOC_UPDATE_FIELD_FLAGS = ["title", "description", "tag", "type", "body", "body-file"] as const;

/** `doc update` standard value flags that consume the next token (or `=value`) as a single string. */
const DOC_UPDATE_VALUE_FLAGS = new Set([
  "title",
  "description",
  "type",
  "body",
  "body-file",
  "dir",
  "remote",
  "expected-version",
  "actor",
]);
/** `doc update` standard boolean flags — no value; `--flag=value` on one of these is a USAGE error. */
const DOC_UPDATE_BOOLEAN_FLAGS = new Set(["keep-timestamp", "strict", "json", "replace-links"]);

interface ParsedDocUpdateArgs {
  help: boolean;
  json: boolean;
  dir?: string;
  remote?: string;
  keepTimestamp: boolean;
  strict: boolean;
  replaceLinks: boolean;
  title?: string;
  description?: string;
  tags?: string[];
  type?: string;
  /** `undefined` = not given at all; `""` = an explicit empty value (`--body ""`) — same distinction `values.body !== undefined` made. */
  body?: string;
  bodyFile?: string;
  /** `undefined` = not given; `""` = present-but-blank (a USAGE error, checked by the caller). */
  expectedVersion?: string;
  /** `undefined` = not given; `""` = present-but-blank (a USAGE error, checked by the caller). */
  actor?: string;
  positionals: string[];
  /** Every `--<field>` NOT among the standard flags above, captured as a kind-field candidate (repeatable → array). */
  kindFields: Map<string, string[]>;
}

/**
 * Parse `doc update`'s HYBRID grammar via `node:util` `parseArgs` (retiring the last hand-rolled
 * command tokenizer). Standard flags are DECLARED in the `parseArgs` options — so `parseArgs` owns
 * all character-level tokenization (`--x=y`, quoting, `--`, `-h`, and NAMING a shell-glued token) —
 * but each value flag's VALUE is read back from its OWN option token in the walk below, NOT off
 * `values`: under `strict:false` a configured `type:"string"` option given no trailing value comes
 * back as boolean `true` (not `undefined`, and parseArgs does not throw), which read blindly would
 * silently persist e.g. `title:true` or crash a later `.trim()`. `--tag`'s repeatable
 * "replace-the-whole-set" array and `--body`'s "even `''` counts as explicit" distinction are
 * preserved by that walk. Because a doc's kind fields aren't known until the doc's
 * `type` is read at MUTATE time (and may be `--type`-overridden), they CANNOT be configured up
 * front — so the parse runs `strict:false, tokens:true` and a token walk buckets each option: a
 * KNOWN value/boolean flag is handled with its typed semantics; any OTHER `--<field>` /
 * `--<field>=<value>` is captured as a dynamic kind-field candidate (its value taken from the
 * adjacent leaked-positional token that `strict:false` produces) and validated LATE in
 * `buildCandidate` (unknown field / ungoverned type -> USAGE, exit 2 — the taxonomy is unchanged;
 * only some malformed-flag messages improve). `parseArgs` owns all character-level tokenization
 * (`--x=y`, quoting, `--`, short `-h`, and NAMING a shell-glued token). Unlike `new` — whose Kind
 * positional is known before parsing, licensing a strict kind-aware config — pre-reading this doc's
 * type for a strict config would be an extra read AND unsound under concurrency.
 */
function parseDocUpdateArgs(argv: string[]): ParsedDocUpdateArgs {
  const { values: rawValues, tokens } = parseOrUsage(
    () =>
      parseArgs({
        args: argv,
        tokens: true,
        strict: false, // dynamic kind fields are unconfigured — strict:true would reject them
        allowPositionals: true,
        options: {
          title: { type: "string" },
          description: { type: "string" },
          type: { type: "string" },
          body: { type: "string" },
          "body-file": { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          "expected-version": { type: "string" },
          actor: { type: "string" },
          tag: { type: "string", multiple: true },
          "keep-timestamp": { type: "boolean" },
          strict: { type: "boolean" },
          "replace-links": { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }),
    "doc update",
    deferArity("doc-update:token-normalization"),
  );
  // Boolean flags are read straight off `rawValues` at the return (each wrapped in `Boolean(...)`,
  // which safely coerces the `string | boolean | undefined` that `strict:false` types every value
  // as). STRING value flags are deliberately NOT read from `rawValues`: under `strict:false` a
  // configured `type:"string"` option given no trailing value comes back as boolean `true`
  // (`--title` at end → `title:true`; `--tag` at end → `tag:[true]`) WITHOUT throwing — reading that
  // back would persist `title:true` (silent corruption) or crash a later `.trim()`. The token walk
  // below instead takes each value flag's value from its OWN option token (`tok.value`, a real
  // `string | undefined`) and throws a clean USAGE when absent, reproducing the retired parser's
  // `takeValue()` guard AND keeping the value type-honest (no `string|boolean` cast for tsc to trust).
  const std: Record<string, string> = {}; // single-value standard flags, keyed by long-option name
  const tags: string[] = []; // --tag, repeatable → replace-the-whole-set array
  const positionals: string[] = [];
  const kindFields = new Map<string, string[]>();
  const consumed = new Set<number>(); // argv indices consumed as an unknown option's value

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]!;
    if (tok.kind === "option-terminator") continue; // bare `--`: trailing args already positional
    if (tok.kind === "positional") {
      if (consumed.has(tok.index)) continue; // was an unknown option's value
      positionals.push(tok.value);
      continue;
    }
    // tok.kind === "option"
    const name = tok.name;
    if (name === "help") continue; // -h/--help -> read from rawValues.help
    if (DOC_UPDATE_BOOLEAN_FLAGS.has(name)) {
      if (tok.value !== undefined) {
        // strict:false won't reject a boolean given `=value`; reject it here instead.
        throw new CliError("USAGE", `--${name} does not take a value (got --${name}=${tok.value})`, {
          help: `${cliInvocation()} doc update --help`,
        });
      }
      continue; // value read from rawValues.<name>
    }
    if (DOC_UPDATE_VALUE_FLAGS.has(name)) {
      // parseArgs already associated the value onto this token (`--x v`, `--x=v`, even greedily
      // consuming a following `--flag` as the value); a MISSING value leaves `tok.value` undefined
      // (parseArgs fell back to boolean `true`) → the same clean USAGE the retired `takeValue()` threw.
      if (tok.value === undefined) {
        throw new CliError("USAGE", `--${name} requires a value`, { help: `${cliInvocation()} doc update --help` });
      }
      std[name] = tok.value; // last-wins across repeats, matching the retired parser
      continue;
    }
    if (name === "tag") {
      if (tok.value === undefined) {
        throw new CliError("USAGE", "--tag requires a value", { help: `${cliInvocation()} doc update --help` });
      }
      tags.push(tok.value); // repeatable → accumulate the replace-the-whole-set array
      continue;
    }

    // Not a standard flag: a candidate kind-declared field. Validated once the registry is loaded
    // (unknown field / ungoverned type / typo of a standard flag are all rejected there, USAGE/exit 2).
    let value: string | undefined;
    if (tok.value !== undefined) {
      value = tok.value; // --status=done (=form)
    } else {
      const next = tokens[t + 1];
      if (next && next.kind === "positional" && next.index === tok.index + 1) {
        value = next.value; // --status done (adjacent positional)
        consumed.add(next.index);
      }
    }
    if (value === undefined) {
      throw new CliError("USAGE", `--${name} requires a value`, { help: `${cliInvocation()} doc update --help` });
    }
    const arr = kindFields.get(name) ?? [];
    arr.push(value);
    kindFields.set(name, arr);
  }

  return {
    help: Boolean(rawValues.help),
    json: Boolean(rawValues.json),
    dir: std.dir,
    remote: std.remote,
    keepTimestamp: Boolean(rawValues["keep-timestamp"]),
    strict: Boolean(rawValues.strict),
    replaceLinks: Boolean(rawValues["replace-links"]),
    title: std.title,
    description: std.description,
    tags: tags.length > 0 ? tags : undefined,
    type: std.type,
    body: std.body,
    bodyFile: std["body-file"],
    expectedVersion: std["expected-version"],
    actor: std.actor,
    positionals,
    kindFields,
  };
}

export async function docUpdate(argv: string[], deps: Partial<DocCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const readStdin = deps.readStdin ?? defaultReadStdin;

  const p = parseDocUpdateArgs(argv);
  if (p.help) {
    stdout(DOC_UPDATE_USAGE);
    return;
  }
  assertLeafArity("doc update", p.positionals);

  const rawId = p.positionals[0]?.trim();
  if (!rawId) {
    throw new CliError("USAGE", "doc update requires a concept <id> positional", {
      help: `${cliInvocation()} doc update <id> --title <t>`,
    });
  }
  let id = conceptIdFromCliArgument(rawId);
  // A PRESENT-but-blank `--expected-version` is a USAGE error, not "no CAS" — mirrors `doc
  // delete`'s identical guard. Coercing a blank flag to `undefined` here would SILENTLY downgrade
  // an intended compare-and-swap claim into an unconditional (bounded-retry) update.
  if (p.expectedVersion !== undefined && p.expectedVersion.trim() === "") {
    throw new CliError(
      "USAGE",
      "--expected-version was given an empty value — pass a real version token (from a prior read/write receipt) or omit the flag for a normal (retrying) update.",
      { help: `${cliInvocation()} doc update ${id} --expected-version <v>` },
    );
  }
  const actor = resolveActor(p.actor, { help: `${cliInvocation()} doc update ${id} --actor <name>` });

  // A patchable field OTHER than body, given via a flag — title/description/tag/type/kind fields.
  // Computed BEFORE the stdin read below: a FIELD-ONLY patch (one of these given, no --body/
  // --body-file) must never touch stdin at all. Many agent harnesses hand a spawned process an fd 0
  // that IS a real pipe/socket (so `hasRealStdinInput` correctly says "real data source") but whose
  // write end is held open with nothing ever written and never closed — reading it to EOF then blocks
  // forever, even though the caller plainly gave everything the patch needed via flags. (Live incident:
  // `doc update <id> --title … --description …` hung indefinitely under exactly this stdin shape.)
  const otherFieldGiven =
    p.title !== undefined ||
    p.description !== undefined ||
    (p.tags !== undefined && p.tags.length > 0) ||
    p.type !== undefined ||
    p.kindFields.size > 0;

  // Body source: --body wins, then --body-file, then piped stdin — but stdin is consulted ONLY as a
  // last resort, when NOTHING else was given either (e.g. `cat body.md | … doc update x` with no
  // other flags) — mirrors `doc write`'s F1 guard's "empty stdin counts as nothing given" rule for the
  // non-empty check itself. Read stdin (if relevant) ONCE, before the CAS retry loop below — the
  // stream can only be consumed once.
  let stdinBody: string | undefined;
  // See STDIN_SILENT_TIMEOUT in common.ts: a real-but-silent stdin reads as "nothing given", but the
  // no-field USAGE error below names the condition so the caller can tell "I gave nothing" apart
  // from "my piped body arrived too late".
  let stdinSilentTimeout = false;
  if (p.body === undefined && !p.bodyFile && !otherFieldGiven) {
    const raw = await readStdin();
    stdinSilentTimeout = raw === STDIN_SILENT_TIMEOUT;
    stdinBody = typeof raw === "string" && raw !== "" ? raw : undefined;
  }

  // A patch verb with nothing to patch has no meaningful effect — reject rather than silently no-op,
  // so a caller who forgot a flag gets an actionable error instead of a doc that looks "updated" but
  // changed nothing (control flags like --keep-timestamp/--strict do not count as a patch by themselves).
  const anyFieldGiven =
    otherFieldGiven ||
    p.body !== undefined ||
    Boolean(p.bodyFile) ||
    stdinBody !== undefined;
  if (!anyFieldGiven) {
    throw new CliError(
      "USAGE",
      `doc update requires at least one field to patch (${DOC_UPDATE_FIELD_FLAGS.map((f) => `--${f}`).join("/")} ` +
        `or a kind-declared --<field>, e.g. --status)` +
        // The same silent-stdin signal doc write's receipt carries (see write.ts): when the probe
        // timed out, "nothing to patch" may really mean "your piped body arrived too late".
        (stdinSilentTimeout ? `. Note: ${STDIN_SILENT_NOTE}.` : ""),
      { help: `${cliInvocation()} doc update ${id} --title <t>` },
    );
  }

  const bundle = await openBundle(p.dir, await resolveRemoteFlag(p.remote, p.dir));
  id = await resolveConceptIdCliArgument(bundle, rawId);
  const mode = resolveMode({ json: p.json });

  // Load the kind registry ONCE (it doesn't depend on this doc's version) — used below to validate
  // the RESULT of the patch, mirroring `doc write`'s warn-by-default/--strict contract, AND to
  // authorize any dynamic kind-field flags.
  const registry = await loadKinds(bundle);

  // Fork 2: a patch touching ANY kind-declared field is validated STRICTLY (a non-empty warning set —
  // incl. an out-of-enum value — rejects with USAGE/exit 2 and does NOT write), even without --strict.
  // A patch touching ONLY standard fields keeps the pre-existing warn-by-default behavior (--strict
  // still opts in). See the plan's Fork 2 for the full rationale.
  const strict = p.strict || p.kindFields.size > 0;

  // "patch" mode, onAbsent: "fail": `mutateDoc` does the versioned-read -> build -> idempotency ->
  // validate -> CAS-write-with-bounded-retry itself (the exact shape `link add` proved for this
  // seam) and throws our NOT_FOUND/STALE_HEAD before/after `buildCandidate` ever runs on an absent
  // doc, so `existing` below is guaranteed defined.
  const result = await mutateDoc({
    bundle,
    id,
    mode: "patch",
    onAbsent: "fail",
    registry,
    remoteUrl: p.remote,
    strict,
    helpOnKindReject: `${cliInvocation()} kinds`,
    actor,
    persistActor: true,
    expectedVersion: p.expectedVersion?.trim(),
    // Board self-attribution (PR C): a `changed: false` no-op never records (mutate.ts's
    // post-persist contract), so ambient attribution cannot manufacture a "self" actor.
    onPersisted: boardPostPersistHook(bundle, actor),
    buildCandidate: async (existingDoc) => {
      const existing = existingDoc!;
      const nextFrontmatter: Frontmatter = { ...existing.frontmatter };
      if (p.title !== undefined) nextFrontmatter.title = p.title;
      if (p.description !== undefined) nextFrontmatter.description = p.description;
      if (p.tags && p.tags.length > 0) nextFrontmatter.tags = p.tags;
      if (p.type !== undefined) nextFrontmatter.type = p.type.trim();
      // Actor attribution is applied by `mutateDoc` only after this candidate has proven
      // substantive. The spread preserves the previous actor on a no-op; ambient attribution can
      // never turn an identical patch into a write.
      // `timestamp` means "last meaningful change" (OKF + VISION); a patch IS one, so refresh it by
      // default — `--keep-timestamp` opts back into preserving the existing value (mirrors `link
      // add`). `mutateDoc`'s ignoring-timestamp idempotency check decides whether this refreshed
      // value ever reaches disk (a true no-op patch discards it, same as before this refactor).
      if (!p.keepTimestamp) nextFrontmatter.timestamp = new Date().toISOString();

      let nextBody = existing.body;
      if (p.body !== undefined) nextBody = p.body;
      else if (p.bodyFile) nextBody = await fs.readFile(p.bodyFile, "utf8");
      else if (stdinBody !== undefined) nextBody = stdinBody;

      // Link-drop guard (data loss): a body replace must not silently drop outbound cross-links the
      // existing body carried — see `guardDroppedLinks`'s own comment for the exact match rule and
      // why the ordinary read-modify-write cycle never fires it. A no-op re-run of `nextBody ===
      // existing.body` (field-only patch, or a body flag that repeats the current body) trivially
      // clears it (no dropped links vs. itself). `--replace-links` opts into the drop.
      guardDroppedLinks(bundle, existing, nextBody, p.replaceLinks);

      // Dynamic kind-field patch (Facet 2): only accepted when a kind governs the RESULT type and
      // declares the field — the ONLY dynamic-field mechanism on this surface (matches `new`'s
      // strictness; no command lets a flag write an arbitrary, undeclared frontmatter key).
      if (p.kindFields.size > 0) {
        const resultType = p.type !== undefined ? p.type.trim() : String(existing.frontmatter.type);
        const kind = registry.kinds.get(resultType);
        if (!kind) {
          // A `Convention` doc IS the schema, so its `fields`/`governs`/enum keys are not patchable as
          // "kind fields" — signpost the sanctioned schema-edit path here too (cold-start study r3: the
          // pull→edit→promote route only surfaced on the `doc write` refusal, so an agent that reached
          // for `doc update` first hit this dead-end with no way forward).
          const governedKind =
            typeof existing.frontmatter.governs === "string" && existing.frontmatter.governs.trim()
              ? existing.frontmatter.governs
              : "<Kind>";
          const schemaHint =
            resultType === "Convention"
              ? ` To change a kind's SCHEMA (add/remove a declared field or enum value), use ` +
                `\`${cliInvocation()} kind field "${governedKind}" add/remove <name>\` (or edit the convention frontmatter directly).`
              : "";
          throw new CliError(
            "USAGE",
            `no kind governs type '${resultType}', so kind field(s) ${[...p.kindFields.keys()].map((f) => `--${f}`).join(", ")} ` +
              `cannot be patched here — only the standard fields (--title/--description/--tag/--type/--body/--body-file) ` +
              `are patchable on an ungoverned doc.` +
              schemaHint,
            { help: `${cliInvocation()} kinds` },
          );
        }
        const declared = [...kind.fields.required, ...kind.fields.optional];
        const unknown = [...p.kindFields.keys()].filter((f) => !declared.includes(f));
        if (unknown.length > 0) {
          throw new CliError(
            "USAGE",
            `unknown field(s) for kind '${kind.governs}': ${unknown.join(", ")} ` +
              `(declared: ${declared.length > 0 ? declared.join(", ") : "none"}; standard patch flags: ` +
              `title, description, tag, type, body, body-file)` +
              ` — to ADD a field to the '${kind.governs}' kind: \`${cliInvocation()} kind field "${kind.governs}" add <name>\`.`,
            { help: `${cliInvocation()} kinds` },
          );
        }
        for (const [field, vals] of p.kindFields) {
          nextFrontmatter[field] = vals.length === 1 ? vals[0] : vals;
        }
      }

      return { frontmatter: nextFrontmatter, body: nextBody };
    },
    errors: {
      notFound: () =>
        new CliError("NOT_FOUND", `no concept document at id '${id}'`, { help: `${cliInvocation()} list` }),
      staleHead: (err) =>
        new CliError(
          "STALE_HEAD",
          `'${id}' has moved since --expected-version ${err.expected} was read (current: ` +
            `${err.actual ?? "absent"}) — re-read and retry with the current version.`,
          { help: `${cliInvocation()} doc read ${id}`, details: { expected: err.expected, actual: err.actual } },
        ),
    },
  });

  const receipt: Record<string, unknown> = {
    doc: "updated",
    id: result.doc.id,
    type: result.doc.frontmatter.type,
    timestamp: result.doc.frontmatter.timestamp ?? null,
    changed: result.changed,
    // The doc's version AFTER this patch (or its unchanged head on a no-op) — the token for a
    // subsequent `--expected-version` compare-and-swap.
    version: result.version,
  };
  if (result.warnings.length > 0) receipt.warnings = result.warnings;
  // Legacy-naming nudge (legacy-page.ts): fires on the RESULT doc's type at an authoring moment
  // only — never blocks, never on reads.
  if (isLegacyPageDoc(result.doc.frontmatter)) receipt.hint = LEGACY_PAGE_TYPE_HINT;
  receipt.help = [`${cliInvocation()} doc read ${result.doc.id}`];
  stdout(render(receipt, mode));
}
