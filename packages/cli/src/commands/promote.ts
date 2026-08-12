// `agentstate-lite promote <file> --doc-key <key>` — the out-of-band byte-IN channel: move a local
// file's bytes into the store WITHOUT the content ever entering the model context window (the
// reverse of `doc read --out`; the write-side counterpart to `pull`).
//
// ROUTES BY TARGET (A6, confirmed sound in rev5): a `--doc-key` ending `.md` — checked
// CASE-INSENSITIVELY, B6 (`report.MD` must route the same as `report.md`, or it would collide with
// the blob-layer's own `.md` rejection and silently miss the concept-document namespace entirely)
// — is a DOC: the FILE is parsed with core's ONE frontmatter parser (`parseMarkdown`) and written
// through the ENGINE (`writeDocVersioned`; doc id = the key minus `.md`, via `conceptIdFromPath` —
// reserved-filename rejection and OKF §9.2 (non-empty `type`) come FREE from the engine, no
// reimplementation here). A governing kind convention is validated exactly as `doc write` (the SAME
// shared helper, B8 — warn-by-default, `--strict` rejects). Every OTHER key routes through
// `writeBlob` (opaque bytes + a content-type, never parsed). `--content-type` with a `.md` key is a
// USAGE error (I9) — content-type is a blob-route-only concept; A11: the doc route passes through
// exactly what the FILE's OWN frontmatter says, no CLI metadata flags.
//
// CAS (I9): promote v1 supports token-CAS ONLY via `--expected-version <token>`. Omitting it does
// NOT mean "unconditional overwrite" — it means EXPECT-ABSENT CREATE (`expectedVersion: null`, the
// SAME create-only discipline `new` uses for kind instances): the write succeeds only if `--doc-key`
// does not yet exist. Updating an EXISTING target always requires the CAS token from a prior
// `pull`/`promote` receipt — never a silent last-writer-wins clobber. A8b/c: a stale/mismatched
// token is a CONFLICT (exit 5) whose envelope carries the CURRENT version, so the losing editor can
// re-`pull` -> re-apply -> re-`promote` without a second discovery round trip.
//
// A6/A9 context: for a LOCAL `--dir` bundle this is a convenience only — the files ARE the store
// (local-first) — but routing a `.md` file through the engine still doubles as IMPORT+NORMALIZE
// (frontmatter key order, a defaulted timestamp, kind validation), exactly as `doc write` would.
// Over `--remote`, the verbs are load-bearing: there is no other way to get bytes into a served
// bundle. Principle: commands are the control channel, files are the content channel.
import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import {
  writeBlob,
  writeDocVersioned,
  parseMarkdown,
  conceptIdFromPath,
  loadKinds,
  resolveContentType,
  VersionConflict,
  type Bundle,
} from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError, classifyBundleError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode, type OutputMode } from "../output.js";
import { cliInvocation } from "../invocation.js";
import { defaultTimestampAndValidateKind } from "../kind-write.js";
import { isLegacyPageDoc, LEGACY_PAGE_TYPE_HINT } from "../legacy-page.js";

export const PROMOTE_USAGE = `agentstate-lite promote — move a local file's bytes into the store (the reverse of 'doc read --out')

Usage:
  agentstate-lite promote <file> --doc-key <key> [options]

Routes by the --doc-key's target (checked case-insensitively):
  A key ending '.md' is a DOC: the file is parsed as an OKF concept (YAML frontmatter + markdown
  body) and written through the engine — doc id = the key minus '.md'. The file's OWN frontmatter
  is passed through verbatim (no CLI metadata flags on this route — edit the file locally, that is
  the whole loop). A governing kind convention is validated exactly like 'doc write' (warn-by-
  default; --strict rejects, exit 2, no write). --content-type is a USAGE error on this route.
  Any OTHER key is a BLOB: opaque bytes + a content-type, never parsed or normalized.

CAS: omitting --expected-version means EXPECT-ABSENT CREATE — the write succeeds only if <key> does
NOT already exist (the same create-only discipline 'new' uses). Updating an EXISTING target always
requires --expected-version <token> (from a prior 'pull'/'promote' receipt); a stale token is a
CONFLICT (exit 5) whose envelope carries the CURRENT version, so you can re-pull -> re-apply your
edit -> re-promote without a second discovery call.

Locally (--dir) this is a convenience — the files ARE the store — but a .md promote still doubles
as IMPORT+NORMALIZE (frontmatter key order, a defaulted timestamp, kind validation), same as 'doc
write'. Over --remote it is load-bearing: there is no other way to get bytes into a served bundle.

The receipt's content_type reports the WRITE-TIME resolution (override, else inferred from the
key's extension) — history-less backends (the local filesystem) do not persist an explicit
override and RE-INFER from the extension on every subsequent read, so a follow-up 'pull' may
report a different content_type than this receipt did; backends that keep state (a remote,
document-centric store) persist the override and pull reports it back unchanged.

Options:
  --doc-key <key>          Destination key (required) — ends '.md' -> doc route, else blob route
  --content-type <mime>    Blob route only (USAGE error with a .md key); default: inferred from the
                            key's extension, else application/octet-stream
  --expected-version <v>   Compare-and-swap token from a prior pull/promote receipt (omit = expect-
                            absent create; see CAS above)
  --strict                 Doc route only: reject (exit 2) instead of writing-with-warnings when a
                            kind convention governs the doc's type and it does not satisfy it
  --dir <path>              Bundle directory (default: discovered from the cwd)
  --remote <url>            Talk to a wire-protocol server instead of a local bundle (mutually
                            exclusive with --dir; remote access is always explicit)
  --json                    Emit compact JSON instead of TOON
  -h, --help                Show this help
`;

export interface PromoteCliDeps {
  stdout: (s: string) => void;
}

/** True when `key`'s final segment ends `.md`, checked CASE-INSENSITIVELY (B6). */
function isDocRouteKey(key: string): boolean {
  return key.toLowerCase().endsWith(".md");
}

export async function promote(argv: string[], deps: Partial<PromoteCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          "doc-key": { type: "string" },
          "content-type": { type: "string" },
          "expected-version": { type: "string" },
          strict: { type: "boolean" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.promote,
  );
  if (values.help) {
    stdout(PROMOTE_USAGE);
    return;
  }

  const file = positionals[0]?.trim();
  if (!file) {
    throw new CliError("USAGE", "promote requires a local <file> positional", {
      help: `${cliInvocation()} promote <file> --doc-key <key>`,
    });
  }
  const key = values["doc-key"]?.trim();
  if (!key) {
    throw new CliError("USAGE", "--doc-key <key> is required", {
      help: `${cliInvocation()} promote ${file} --doc-key <key>`,
    });
  }

  const docRoute = isDocRouteKey(key);
  if (docRoute && values["content-type"] !== undefined) {
    throw new CliError(
      "USAGE",
      `--content-type is a blob-route-only option; '${key}' ends in '.md' and routes through the ` +
        `doc engine, which passes through the file's OWN frontmatter instead (I9)`,
      { help: `${cliInvocation()} promote --help` },
    );
  }

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const mode = resolveMode(values);
  // I9: promote v1 supports token-CAS only via --expected-version; omitting it means EXPECT-ABSENT
  // create (null), never an unconditional last-writer-wins overwrite.
  const expectedVersion = values["expected-version"] ?? null;

  if (docRoute) {
    await promoteDoc(file, key, bundle, { expectedVersion, strict: Boolean(values.strict) }, stdout, mode, values.remote);
    return;
  }
  await promoteBlob(file, key, bundle, { expectedVersion, contentType: values["content-type"] }, stdout, mode, values.remote);
}

async function promoteDoc(
  file: string,
  key: string,
  bundle: Bundle,
  opts: { expectedVersion: string | null; strict: boolean },
  stdout: (s: string) => void,
  mode: OutputMode,
  remoteUrl?: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    throw promoteFileReadError(err, file);
  }
  const { frontmatter, body } = parseMarkdown(raw);

  // I10: a designed UX, not a bare engine message about a "concept" the user never named — check
  // BEFORE ever calling the engine (rather than pattern-matching its thrown Error's message) and
  // name the FILE PATH with a pointer at the frontmatter shape / `new`.
  if (typeof frontmatter.type !== "string" || frontmatter.type.trim() === "") {
    throw new CliError(
      "USAGE",
      `'${file}' has no usable frontmatter (missing, or missing a non-empty 'type' field) — a ` +
        `promoted '.md' file must be a valid OKF concept document (YAML frontmatter starting with ` +
        `at least 'type: <Kind>'). See '${cliInvocation()} kinds' for declared kinds, or ` +
        `'${cliInvocation()} new "<Kind>" <id> ...' to scaffold one correctly.`,
      { help: `${cliInvocation()} new --help` },
    );
  }

  // Canonicalize a case-insensitively-'.md' key (e.g. 'Report.MD', B6) to the exact lowercase
  // suffix `conceptIdFromPath` expects before reusing THAT one function (A6 rev5: "doc id =
  // conceptIdFromPath") — conceptIdFromPath's own `.md` check is case-sensitive, so calling it on
  // the raw mixed-case key would silently fail to strip the extension.
  const canonicalPath = key.slice(0, -3) + ".md";
  const id = conceptIdFromPath(canonicalPath);
  const candidate = { id, frontmatter, body };

  const registry = await loadKinds(bundle);
  const warnings = defaultTimestampAndValidateKind(candidate, registry, {
    strict: opts.strict,
    helpOnReject: `${cliInvocation()} kinds`,
    // I9: an omitted --expected-version is an EXPECT-ABSENT create (the doc does not yet exist); a
    // present one implies the caller read the doc first to get that token, so it already exists.
    docExists: opts.expectedVersion !== null,
  });

  // Scope decision (tasks/overwrite-monotone-ratchet): this route writes directly through
  // writeDocVersioned, not core's mutateDocument overwrite branch — the monotone conformance
  // ratchet does not apply here. promote's byte channel already demands an explicit
  // --expected-version CAS token for an overwrite and offers --strict; that stays the guard.
  let version: string;
  try {
    ({ version } = await writeDocVersioned(bundle, candidate, { expectedVersion: opts.expectedVersion }));
  } catch (err) {
    throw promoteWriteErrorToCliError(err, key, file, remoteUrl);
  }

  const receipt: Record<string, unknown> = {
    promote: "written",
    route: "doc",
    key,
    id: candidate.id,
    type: candidate.frontmatter.type,
    version,
    size_bytes: Buffer.byteLength(raw, "utf8"),
  };
  if (warnings.length > 0) receipt.warnings = warnings;
  // Legacy-naming nudge (legacy-page.ts): the doc route is an authoring moment too — receipt-only,
  // never an error. The blob route has no frontmatter to inspect and stays untouched.
  if (isLegacyPageDoc(candidate.frontmatter)) receipt.hint = LEGACY_PAGE_TYPE_HINT;
  // A10: a ready-to-paste PULL hint closes the loop in the other direction.
  receipt.help = [`${cliInvocation()} pull --doc-key ${key} --out <path>`];
  stdout(render(receipt, mode));
}

async function promoteBlob(
  file: string,
  key: string,
  bundle: Bundle,
  opts: { expectedVersion: string | null; contentType: string | undefined },
  stdout: (s: string) => void,
  mode: OutputMode,
  remoteUrl?: string,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (err) {
    throw promoteFileReadError(err, file);
  }

  let version: string;
  try {
    version = await writeBlob(bundle, key, bytes, opts.contentType, { expectedVersion: opts.expectedVersion });
  } catch (err) {
    throw promoteWriteErrorToCliError(err, key, file, remoteUrl);
  }

  const receipt: Record<string, unknown> = {
    promote: "written",
    route: "blob",
    key,
    // The SAME resolution `writeBlob` used internally (`resolveContentType`, the ONE MIME source,
    // core's content-type.ts) — no extra round trip to read the blob back just to report it.
    content_type: resolveContentType(key, opts.contentType),
    version,
    size_bytes: bytes.byteLength,
  };
  receipt.help = [`${cliInvocation()} pull --doc-key ${key} --out <path>`];
  stdout(render(receipt, mode));
}

/** Map a missing source file (ENOENT — the caller named it, so it's their input) to a USAGE
 * CliError naming the file; anything else (EACCES, EISDIR, …) is an I/O failure for the boundary. */
function promoteFileReadError(err: unknown, file: string): CliError {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new CliError("USAGE", `no such file: '${file}'`, {
      help: `${cliInvocation()} promote <file> --doc-key <key>`,
    });
  }
  return classifyBundleError(err);
}

/**
 * Map a promote write failure to a structured CliError. A8b/c: `VersionConflict`'s envelope always
 * carries the CURRENT version (`details.actual`) so the caller can re-pull -> re-apply -> re-promote
 * without a second discovery round trip. Distinguishes the two conflict shapes: an expect-absent
 * create (`expected === null`) finding something already there maps to the SAME `ALREADY_EXISTS`
 * `new` uses; a stale explicit token maps to `STALE_HEAD` — both are exit 5 (CONFLICT), but the
 * `code` and message differ so an agent (or a human) understands WHICH happened.
 */
function promoteWriteErrorToCliError(err: unknown, key: string, file: string, remoteUrl?: string): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof VersionConflict) {
    const current = err.actual;
    if (err.expected === null) {
      return new CliError(
        "ALREADY_EXISTS",
        `'${key}' already exists — promote with no --expected-version means expect-absent CREATE, ` +
          `not an overwrite. Pass --expected-version ${current ?? "<token>"} (from a prior ` +
          `pull/promote receipt) to update it.`,
        {
          help: `${cliInvocation()} promote ${file} --doc-key ${key} --expected-version ${current ?? "<token>"}`,
          details: { expected: err.expected, actual: err.actual },
        },
      );
    }
    return new CliError(
      "STALE_HEAD",
      `'${key}' has moved since --expected-version ${err.expected} was read (current: ${current ?? "absent"}) ` +
        `— re-pull, re-apply your edit, and re-promote with the current version.`,
      {
        help: `${cliInvocation()} pull --doc-key ${key} --out <path>`,
        details: { expected: err.expected, actual: err.actual },
      },
    );
  }
  // Anything else lands on the one boundary: a typed InvalidInputError (reserved-id, unsafe-id,
  // §9.2) → USAGE, a RemoteError by ITS code (AUTH_REQUIRED/FORBIDDEN/…), an unexpected
  // failure → RUNTIME.
  return classifyBundleError(err, remoteUrl);
}
