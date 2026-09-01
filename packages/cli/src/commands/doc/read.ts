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
  stringifyDoc,
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
import { assertPathOutsidePrivateState } from "../../private-state-bundle-boundary.js";
import {
  DOC_READ_USAGE,
  type DocCliDeps,
  attachBodyPreview,
  BODY_PREVIEW_RESERVED_KEYS,
  readErrorToCliError,
} from "./common.js";
import { MAX_BODY_CHARS, MAX_NODES } from "@superbee/markdown-renderer";
import { renderDocumentToStaticHtml } from "@superbee/markdown-renderer/static";
import { assertSafeNonDocumentOutTarget, inBundlePollutionWarning } from "../egress.js";
import { commandLiteral, commandToken, type CommandText } from "../../command-text.js";

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
          "rendered-out": { type: "string" },
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
  const renderedOutValue = values["rendered-out"];
  const renderedOutPresent = renderedOutValue !== undefined;
  const outPresent = values.out !== undefined;
  const fieldPresent = values.field !== undefined;

  // Each channel reserves stdout for a single payload, so combining any two is ambiguous (which one
  // wins?), not a silent pick-one. PRESENCE selects a channel whatever its value: `--out "$VAR"`
  // with an unset $VAR is a scripting slip that must fail loudly, matching the blank guards below.
  // The error names only the flags actually passed, so the help never points at an unasked channel.
  const selected: { flag: string; usage: CommandText }[] = [];
  if (outPresent) selected.push({ flag: "--out", usage: commandLiteral("--out (<path> | -)") });
  if (bodyOutPresent) selected.push({ flag: "--body-out", usage: commandLiteral("--body-out (<path> | -)") });
  if (renderedOutPresent) selected.push({ flag: "--rendered-out", usage: commandLiteral("--rendered-out (<path> | -)") });
  if (fieldPresent) selected.push({ flag: "--field", usage: commandLiteral("--field <name>") });
  if (selected.length > 1) {
    throw new CliError(
      "USAGE",
      `${selected.map((c) => c.flag).join(", ")} cannot be combined — each selects a different read ` +
        "channel, and each reserves stdout for a single payload.",
      { help: `${cliInvocation()} doc read ${commandToken(id)} ${selected[0]!.usage}` },
    );
  }
  if (bodyOutPresent && bodyOutValue.trim() === "") {
    throw new CliError(
      "USAGE",
      "--body-out was given an empty value — pass a file path or '-' for stdout.",
      { help: `${cliInvocation()} doc read ${commandToken(id)} --body-out (<path> | -)` },
    );
  }
  if (renderedOutPresent && renderedOutValue.trim() === "") {
    throw new CliError(
      "USAGE",
      "--rendered-out was given an empty value — pass a file path or '-' for stdout.",
      { help: `${cliInvocation()} doc read ${commandToken(id)} --rendered-out (<path> | -)` },
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
      { help: `${cliInvocation()} doc read ${commandToken(id)} --field <name>` },
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
    if (!streamMode) {
      // A destination inside private state would land 0644 over an operational record.
      assertPathOutsidePrivateState(path.resolve(bodyOut));
      await assertSafeNonDocumentOutTarget(
        bundle,
        "--body-out",
        bodyOut,
        "body-only markdown",
        `${cliInvocation()} doc read ${commandToken(id)} --body-out <path-outside-bundle>`,
      );
    }
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

  // Rendered-HTML byte channel for static publishers: the SAME canonical bounded renderer every
  // other human surface uses, never a second Markdown stack. An in-bundle `.md` target is refused
  // exactly as `--body-out` refuses one, and for a strictly stronger reason: body-only markdown at
  // least stays markdown, while rendered HTML at a `.md` path is neither a concept doc nor a
  // reserved file. That refusal subsumes `--out`'s in-bundle WARNING for this channel — every
  // shape the warning would describe (re-ingestion, reserved clobber) ends in `.md` and is now
  // refused outright, and an in-bundle non-`.md` target stays inert, so no warning remains to give.
  if (renderedOutPresent) {
    const renderedOut = renderedOutValue.trim();
    const streamMode = renderedOut === "-";
    if (!streamMode) {
      // A destination inside private state would land 0644 over an operational record.
      assertPathOutsidePrivateState(path.resolve(renderedOut));
      await assertSafeNonDocumentOutTarget(
        bundle,
        "--rendered-out",
        renderedOut,
        "rendered HTML",
        `${cliInvocation()} doc read ${commandToken(id)} --rendered-out <path-outside-bundle>`,
      );
    }
    let parsed: OkfDocument;
    let version: Version;
    try {
      ({ doc: parsed, version } = await readDocVersioned(bundle, id));
    } catch (err) {
      throw readErrorToCliError(err, id, values.remote);
    }
    const rendered = renderDocumentToStaticHtml({ id: parsed.id, body: parsed.body });
    const bytes = Buffer.from(rendered.html, "utf8");
    const result: Record<string, unknown> = {
      doc: "read",
      id,
      rendered_out: renderedOut,
      size_bytes: bytes.byteLength,
      content_type: "text/html; charset=utf-8",
      version,
      bounded: rendered.bounded,
    };
    // `bounded` alone is a boolean a publisher has no reason to read as "your page is INCOMPLETE".
    // The bounds are quoted from the renderer's exported constants because the document adapter
    // deliberately returns ONLY {html, bounded} (its own contract test pins that key set), and this
    // call passes no `limits` override — so the constants ARE what the walk enforced.
    // Truncation is lossy egress, so disclose it the way the default render does: a warning plus a
    // pointer at the complete raw channel.
    if (rendered.bounded) {
      result.warning =
        `The rendered HTML is TRUNCATED: this document exceeds the shared renderer's bounds ` +
        `(${MAX_BODY_CHARS} body characters / ${MAX_NODES} nodes), so ` +
        `the tail of the body is NOT present in the output. Use --out for the complete raw markdown.`;
      result.help = [`${cliInvocation()} doc read ${commandToken(id)} --out <file>`];
    }
    if (streamMode) {
      writeStdoutBytes(bytes);
      stderr(render(result, resolveMode(values)));
      return;
    }
    await fs.writeFile(renderedOut, bytes);
    stdout(render(result, resolveMode(values)));
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
    // registry load — a detail render stays a pure engine read (kind registries load ONLY in
    // a command's mutate path, never on a read). Reserved OUTPUT keys are skipped so a pathological
    // frontmatter key can never clobber the body preview the branch below writes.
    const rec: Record<string, unknown> = { id: parsed.id };
    const KNOWN_ORDER = ["type", "title", "description", "resource", "tags", "timestamp"];
    const RESERVED_OUTPUT = new Set(["id", "head_version", ...BODY_PREVIEW_RESERVED_KEYS]);
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
    // `attachBodyPreview` (common.ts) owns the truncation identity itself — the `body_preview` key
    // and the in-value marker that make the result unusable as a full body by accident. Both help
    // lines are complete-body channels: `--out` for the whole document, `--body-out` for the
    // body-only edit cycle that ends in `doc update --body-file --expected-version`.
    attachBodyPreview(rec, parsed.body, [
      `${cliInvocation()} doc read ${commandToken(parsed.id)} --out <file>`,
      `${cliInvocation()} doc read ${commandToken(parsed.id)} --body-out <path-outside-bundle>`,
    ]);
    stdout(render(rec, resolveMode(values)));
    return;
  }

  // Byte channel: read the raw markdown file bytes and write them to disk or stream to stdout.
  const streamMode = out === "-";
  // A destination inside private state would land 0644 over an operational record.
  if (!streamMode) assertPathOutsidePrivateState(path.resolve(out));

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
    const warning = await inBundlePollutionWarning(bundle, out);
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
    if ((arg === "--out" || arg === "--body-out" || arg === "--rendered-out") && argv[i + 1]?.trim() === "-") return true;
    if (arg?.startsWith("--out=") && arg.slice("--out=".length).trim() === "-") return true;
    if (arg?.startsWith("--body-out=") && arg.slice("--body-out=".length).trim() === "-") return true;
    if (arg?.startsWith("--rendered-out=") && arg.slice("--rendered-out=".length).trim() === "-") return true;
  }
  return false;
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
    help: `${cliInvocation()} doc read ${commandToken(id)}`,
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
