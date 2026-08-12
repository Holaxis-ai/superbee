// `doc read <id>` — see `../doc.ts`'s header comment for the full F3 (P2, bundle pollution)
// rationale for the `--out` byte channel and `inBundlePollutionWarning` below.
import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readDoc,
  readDocVersioned,
  pathFromConceptId,
  assertSafeConceptId,
  inferContentTypeFromDocKey,
  isReservedFile,
  stringifyDoc,
  type Bundle,
  type OkfDocument,
  type Version,
} from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../../bundle.js";
import { maybeAutoPull } from "../../autopull.js";
import { CliError, toExit, asHandled } from "../../errors.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { render, resolveMode, renderErrorEnvelope } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import { DOC_READ_USAGE, type DocCliDeps, BODY_PREVIEW_LIMIT, readErrorToCliError } from "./common.js";

export async function docRead(argv: string[], deps: Partial<DocCliDeps>): Promise<void> {
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const rawStdoutReserved = requestsStdoutByteChannel(argv);
  if (!rawStdoutReserved) return docReadInner(argv, deps);

  // Detect the raw-stdout contract from argv BEFORE parseArgs, bundle discovery, or any I/O. That
  // makes the channel invariant unconditional: even an unknown option, missing positional, bundle
  // resolution failure, or malformed stored doc can only emit its envelope on stderr. The handled
  // check prevents double emission if a deeper shared helper has already routed the error itself.
  try {
    await docReadInner(argv, deps);
  } catch (err) {
    const { envelope, handled } = toExit(err);
    if (!handled) stderr(renderErrorEnvelope(envelope));
    throw handled ? err : asHandled(err);
  }
}

async function docReadInner(argv: string[], deps: Partial<DocCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const writeStdoutBytes = deps.writeStdoutBytes ?? ((d: Uint8Array) => void process.stdout.write(d));

  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          out: { type: "string" },
          "body-out": { type: "string" },
          field: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.docRead,
  );
  if (values.help) {
    stdout(DOC_READ_USAGE);
    return;
  }

  const rawId = positionals[0]?.trim();
  if (!rawId) {
    throw new CliError("USAGE", "doc read requires a concept <id> positional", {
      help: `${cliInvocation()} doc read <id>`,
    });
  }
  let id = conceptIdFromCliArgument(rawId);

  const bodyOutValue = values["body-out"];
  const bodyOutPresent = bodyOutValue !== undefined;
  const outPresent = values.out !== undefined;
  const fieldPresent = values.field !== undefined;

  if (bodyOutPresent && (outPresent || fieldPresent)) {
    throw new CliError(
      "USAGE",
      "--body-out cannot be combined with --out or --field — each selects a different read channel.",
      { help: `${cliInvocation()} doc read ${id} --body-out (<path> | -)` },
    );
  }
  if (bodyOutPresent && bodyOutValue.trim() === "") {
    throw new CliError(
      "USAGE",
      "--body-out was given an empty value — pass a file path or '-' for stdout.",
      { help: `${cliInvocation()} doc read ${id} --body-out (<path> | -)` },
    );
  }

  // --field and --out both reserve stdout for a single raw payload — combining them is ambiguous
  // (which one wins?), not a silent pick-one.
  if (values.field !== undefined && values.out !== undefined && values.out.trim() !== "") {
    throw new CliError(
      "USAGE",
      "--field and --out cannot be combined — both reserve stdout for a single raw value.",
      { help: `${cliInvocation()} doc read ${id} --field <name>` },
    );
  }
  // A present-but-blank --field is a USAGE error, not "no field given" (mirrors --expected-version/
  // --actor's own blank-value guard elsewhere in this command family) — a scripting slip
  // (`--field "$VAR"` with an unset $VAR) should fail loudly, not silently fall through to the
  // default full-record render.
  if (values.field !== undefined && values.field.trim() === "") {
    throw new CliError(
      "USAGE",
      "--field was given an empty value — pass a frontmatter field name (or id/type/head_version).",
      { help: `${cliInvocation()} doc read ${id} --field <name>` },
    );
  }
  const field = values.field?.trim();

  const remote = await resolveRemoteFlag(values.remote, values.dir);
  // Opportunistic board freshness (autopull.ts): silent, fail-soft, detection-gated — see list.ts.
  // Runs on the READ verb only (never doc write/update/delete — the trigger is for reads).
  if (!remote) await (deps.autoPull ?? maybeAutoPull)(values.dir);
  const bundle = await openBundle(values.dir, remote);
  id = await resolveConceptIdCliArgument(bundle, rawId);

  // Body-only byte channel: one versioned read owns BOTH the semantic parsed body and the CAS token
  // in the receipt. The resulting file is therefore safe to edit and pass straight to
  // `doc update --body-file ... --expected-version <version>` without parsing frontmatter or racing
  // a second version lookup. This intentionally promises parsed-body semantics, not preservation of
  // the source document's original YAML/newline bytes.
  if (bodyOutPresent) {
    const bodyOut = bodyOutValue.trim();
    const streamMode = bodyOut === "-";
    if (!streamMode) await assertSafeBodyOutTarget(bundle, bodyOut, id);
    const runToTarget = async (): Promise<void> => {
      let parsed: OkfDocument;
      let version: Version;
      try {
        ({ doc: parsed, version } = await readDocVersioned(bundle, id));
      } catch (err) {
        throw readErrorToCliError(err, id, values.remote);
      }
      const bytes = Buffer.from(parsed.body, "utf8");
      const result: Record<string, unknown> = {
        doc: "read",
        id,
        body_out: bodyOut,
        size_bytes: bytes.byteLength,
        content_type: "text/markdown; charset=utf-8",
        version,
      };
      if (streamMode) {
        writeStdoutBytes(bytes);
        stderr(render(result, resolveMode(values)));
        return;
      }
      await fs.writeFile(bodyOut, bytes);
      stdout(render(result, resolveMode(values)));
    };

    await runToTarget();
    return;
  }

  // --field <name>: print ONE raw value for scripting (the headline case is `--field head_version`,
  // capturing the CAS token for a follow-up --expected-version write without shelling out through
  // `| grep | sed` over the TOON record). No envelope, no other stdout output — mirrors --out -'s
  // stdout-purity contract exactly: an error's envelope is routed to STDERR instead (same
  // toExit/renderErrorEnvelope/asHandled dance below), never a second mechanism.
  if (field) {
    try {
      let parsed: OkfDocument;
      let version: Version;
      try {
        ({ doc: parsed, version } = await readDocVersioned(bundle, id));
      } catch (err) {
        throw readErrorToCliError(err, id, values.remote);
      }
      stdout(formatFieldValue(resolveField(parsed, version, field, id)));
    } catch (err) {
      const { envelope } = toExit(err);
      stderr(renderErrorEnvelope(envelope));
      throw asHandled(err);
    }
    return;
  }

  const out = values.out?.trim();

  // Default (no --out): parse + print the doc as a structured record.
  if (!out) {
    let parsed: OkfDocument;
    let version: Version;
    try {
      ({ doc: parsed, version } = await readDocVersioned(bundle, id));
    } catch (err) {
      throw readErrorToCliError(err, id, values.remote);
    }
    const fm = parsed.frontmatter as Record<string, unknown>;
    // AXI §3 detail view: show EVERY frontmatter field (kind-declared ones like `status`/`priority`
    // included), not a hardcoded allowlist. Stable order: `id`, then the known standard keys in
    // canonical order, then any remaining frontmatter keys in the doc's own insertion order. No
    // registry load — a detail render stays a pure engine read (CLAUDE.md gate 3: kinds load ONLY in
    // a command's mutate path, never on a read). Reserved OUTPUT keys are skipped so a pathological
    // frontmatter key can never clobber the body preview the branch below writes.
    const rec: Record<string, unknown> = { id: parsed.id };
    const KNOWN_ORDER = ["type", "title", "description", "resource", "tags", "timestamp"];
    const RESERVED_OUTPUT = new Set(["id", "head_version", "body", "body_truncated", "body_chars", "help"]);
    for (const key of KNOWN_ORDER) {
      if (fm[key] !== undefined && fm[key] !== null) rec[key] = fm[key];
    }
    for (const key of Object.keys(fm)) {
      if (KNOWN_ORDER.includes(key) || RESERVED_OUTPUT.has(key)) continue;
      if (fm[key] === undefined || fm[key] === null) continue;
      rec[key] = fm[key];
    }
    // The store's content-addressed HEAD token — the compare-and-swap basis an agent passes back as
    // `--expected-version` for an optimistic doc update/delete. Named `head_version` (NOT `version`)
    // ONLY on this read view because it dumps ALL frontmatter: a doc may legitimately declare its own
    // domain `version` field (a spec/API/schema version), which must render as itself, not be shadowed
    // by the CAS token — so `doc read` stays consistent with `list --fields version`. (The fixed-shape
    // write/update/new receipts don't dump frontmatter, so they keep the plain `version` key, matching
    // promote/pull.) Surfacing it resolves the #1 optimistic-concurrency discoverability gap.
    rec.head_version = version;
    // AXI §3: never dump a large body to stdout — truncate the preview and point at the byte channel
    // (`doc read <id> --out <file>`), which streams the full raw markdown without touching context.
    const body = parsed.body;
    if (body.length > BODY_PREVIEW_LIMIT) {
      rec.body = body.slice(0, BODY_PREVIEW_LIMIT);
      rec.body_truncated = true;
      rec.body_chars = body.length;
      rec.help = [`${cliInvocation()} doc read ${parsed.id} --out <file>`];
    } else {
      rec.body = body;
    }
    stdout(render(rec, resolveMode(values)));
    return;
  }

  // Byte channel: read the raw markdown file bytes and write them to disk or stream to stdout.
  const streamMode = out === "-";

  const runToTarget = async (): Promise<void> => {
    let bytes: Uint8Array;
    let rel: string;
    if (bundle.backend) {
      // Remote (or any non-filesystem) backend: there is NO raw-bytes wire endpoint yet — the
      // wire ships only parsed { frontmatter, body } (docs/WIRE-PROTOCOL.md, deferred to v1).
      // Source the body through the engine read and re-serialize via core's canonical
      // stringifyDoc, then write those bytes locally. This is byte-identical to the source only
      // for ENGINE-WRITTEN docs (stringifyDoc is exactly what writeDoc used to produce the
      // on-disk bytes in the first place); a hand-edited file with idiosyncratic YAML formatting
      // would re-serialize to the canonical form, not its original bytes.
      let parsed: OkfDocument;
      try {
        parsed = await readDoc(bundle, id);
      } catch (err) {
        throw readErrorToCliError(err, id, values.remote);
      }
      bytes = Buffer.from(stringifyDoc(parsed.frontmatter, parsed.body), "utf8");
      rel = pathFromConceptId(id);
    } else {
      try {
        // Guard against path traversal / absolute escape BEFORE the abs path is even
        // constructed — this command bypasses core's readDoc (it reads raw bytes off
        // disk directly), so it must apply the same id-safety guard core applies.
        assertSafeConceptId(id);
        rel = pathFromConceptId(id);
        bytes = await fs.readFile(path.join(bundle.root, rel));
      } catch (err) {
        throw readErrorToCliError(err, id, values.remote);
      }
    }
    const contentType = inferContentTypeFromDocKey(rel) ?? "text/markdown; charset=utf-8";
    const result: Record<string, unknown> = {
      doc: "read",
      id,
      out,
      size_bytes: bytes.byteLength,
      content_type: contentType,
    };
    if (streamMode) {
      writeStdoutBytes(bytes);
      stderr(render(result, resolveMode(values)));
      return;
    }
    // F3 (P2, bundle pollution): a LOCAL bundle whose resolved --out path lands INSIDE the open
    // bundle's root would otherwise silently re-ingest the exported file as a new concept doc on the
    // next bundle walk (list/query/status). Still write it — a deliberate in-bundle copy (e.g.
    // re-exporting a doc back onto its own canonical path) is conceivable — but attach a loud warning.
    const warning = inBundlePollutionWarning(bundle, out);
    if (warning) result.warning = warning;
    await fs.writeFile(out, bytes);
    stdout(render(result, resolveMode(values)));
  };

  await runToTarget();
}

/** True when raw argv reserves stdout for document/body bytes (split and --flag=- forms). */
function requestsStdoutByteChannel(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--out" || arg === "--body-out") && argv[i + 1]?.trim() === "-") return true;
    if (arg?.startsWith("--out=") && arg.slice("--out=".length).trim() === "-") return true;
    if (arg?.startsWith("--body-out=") && arg.slice("--body-out=".length).trim() === "-") return true;
  }
  return false;
}

/**
 * A body-only markdown file is not an OKF concept document. Refuse a local in-bundle `.md` target
 * before writing, including the source doc itself and reserved index/log files: allowing it would
 * either clobber valid content or make the next bundle walk fail on missing frontmatter.
 */
async function assertSafeBodyOutTarget(bundle: Bundle, bodyOut: string, id: string): Promise<void> {
  if (bundle.backend) return;
  const lexicalTarget = path.resolve(bodyOut);
  const rootReal = await fs.realpath(path.resolve(bundle.root)).catch(() => path.resolve(bundle.root));
  // Resolve the final path when it exists (including a symlink whose own name has no extension).
  // For a not-yet-created target, anchor its full missing suffix under the nearest existing real
  // ancestor so symlinked parent directories cannot hide where fs.writeFile would actually land.
  const effectiveTarget = await effectiveOutputPath(lexicalTarget);
  const inside = (candidate: string, base: string): boolean =>
    candidate === base || candidate.startsWith(base + path.sep);
  const unsafeLexical = inside(lexicalTarget, rootReal) && lexicalTarget.endsWith(".md");
  const unsafeEffective = inside(effectiveTarget, rootReal) && effectiveTarget.endsWith(".md");
  if (!unsafeLexical && !unsafeEffective) return;
  throw new CliError(
    "USAGE",
    `--body-out ${bodyOut} targets ${effectiveTarget}, a .md path INSIDE this bundle (${rootReal}); ` +
      "body-only markdown has no OKF frontmatter and cannot be written into the bundle.",
    { help: `${cliInvocation()} doc read ${id} --body-out <path-outside-bundle>` },
  );
}

/** Resolve an output's effective path even when one or more final path segments do not exist yet. */
async function effectiveOutputPath(absoluteTarget: string): Promise<string> {
  let probe = absoluteTarget;
  const missingSuffix: string[] = [];
  while (true) {
    try {
      return path.join(await fs.realpath(probe), ...missingSuffix);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return absoluteTarget;
      missingSuffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolve a `doc read --field <name>` request to its raw value, or throw NOT_FOUND listing the
 * fields that DO exist (agents self-correct from the receipt rather than guessing). `head_version`
 * and `id` are META names, not frontmatter — `head_version` is the store's CAS token (see the
 * default render's identical `head_version` field above), `id` is derived from the doc's own path —
 * so both are special-cased; every other name (`type` included) is looked up in the doc's OWN
 * frontmatter, the same field set the default detail view dumps. A frontmatter value of `null` is
 * treated as ABSENT, matching the default render's own null/undefined skip.
 */
function resolveField(parsed: OkfDocument, version: Version, field: string, id: string): unknown {
  if (field === "head_version") return version;
  if (field === "id") return parsed.id;
  const fm = parsed.frontmatter as Record<string, unknown>;
  if (fm[field] !== undefined && fm[field] !== null) return fm[field];
  const available = [
    "id",
    "head_version",
    ...Object.keys(fm).filter((key) => fm[key] !== undefined && fm[key] !== null),
  ];
  throw new CliError("NOT_FOUND", `'${id}' has no field '${field}' — fields present: ${available.join(", ")}`, {
    help: `${cliInvocation()} doc read ${id}`,
    details: { field, available },
  });
}

/**
 * Render a --field value RAW for scripting: a scalar (string/number/boolean) prints as-is, no
 * quotes (JSON.stringify would quote a string, which a shell caller doesn't want); an array/object
 * prints as compact single-line JSON, the only shape that can round-trip a non-scalar through a
 * plain stdout line.
 */
function formatFieldValue(value: unknown): string {
  if (typeof value === "object") return `${JSON.stringify(value)}\n`;
  return `${String(value)}\n`;
}

/**
 * F3 (P2, bundle pollution): for a LOCAL bundle (`bundle.backend` absent — a `--remote` bundle's
 * "root" is a URL, not a filesystem path an exported file could ever land inside), classify what an
 * `--out` path landing INSIDE the open bundle's root actually does on the next bundle walk:
 *
 *  - a path whose FINAL segment is a reserved OKF filename (`index.md`/`log.md`, at any directory
 *    level — §3.1) CLOBBERS that reserved file outright, a DIFFERENT failure than re-ingestion (the
 *    walk special-cases reserved files rather than re-parsing them as concepts);
 *  - any other `.md` path is silently RE-INGESTED as a new concept doc (the walk's own filter is
 *    `entry.name.endsWith(".md")` — see `backend.ts` — so it parses every `.md` file's frontmatter);
 *  - a non-`.md` path is inert: the walk never looks at it, so nothing happens on the next bundle
 *    walk and no warning is warranted.
 *
 * Never refuses the write — a deliberate in-bundle copy or reserved-file re-export is conceivable —
 * just makes the ACTUAL risk loud instead of silent (or silently mischaracterized, in the reserved
 * case, which used to get the SAME "re-ingested as a concept" message even though reserved files are
 * never parsed as concepts at all).
 *
 * Exported (not just internal to `doc read --out`) because `pull` (Stage-1 Unit 2a Part C) reuses
 * this EXACT function for its own `--out` byte-out path — the same in-bundle re-ingestion risk
 * applies whenever the resolved OUT PATH itself looks like a concept doc, regardless of whether the
 * bytes being written came from a `doc`-route or `blob`-route pull (a blob pull's `--out` naturally
 * won't trigger this in the common case, since it won't be `.md`-shaped — see `pull.ts`'s usage text
 * on the asymmetry with `doc read --out`).
 */
export function inBundlePollutionWarning(
  bundle: Bundle,
  out: string,
): string | undefined {
  if (bundle.backend) return undefined;
  const resolvedOut = path.resolve(out);
  const root = bundle.root;
  const isInside = resolvedOut === root || resolvedOut.startsWith(root + path.sep);
  if (!isInside) return undefined;

  if (isReservedFile(resolvedOut)) {
    return (
      `--out ${out} resolves to ${resolvedOut}, which is INSIDE this bundle (${root}) at a reserved ` +
      `OKF filename — the write will CLOBBER that reserved file (index.md/log.md is never re-parsed ` +
      `as a concept doc). Pass a path outside the bundle if that is not intended.`
    );
  }
  if (!resolvedOut.endsWith(".md")) return undefined;
  return (
    `--out ${out} resolves to ${resolvedOut}, which is INSIDE this bundle (${root}) — the exported ` +
    `file will be re-ingested as a new concept doc on the next bundle walk (list/query/status). ` +
    `Pass a path outside the bundle if that is not intended.`
  );
}
