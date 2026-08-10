// `agentstate-lite delete --doc-key <key>` — hard-delete a doc or blob by its key, symmetric with
// `promote`/`pull` (the DELETE-operation pass, binding plan item 9 — resolved decision).
//
// ROUTES BY TARGET (case-insensitive `.md` suffix, mirrors `promote`/`pull`'s B6 discipline): a
// `--doc-key` ending `.md` is a DOC — id = the key minus `.md` (via `conceptIdFromPath`,
// canonicalized the SAME way `promote`'s doc route does for a mixed-case suffix like `Report.MD`)
// — deleted through the ENGINE (`deleteDoc`; reserved-file rejection and id-safety come free, the
// same guard `writeDocVersioned` carries). Any OTHER key is a BLOB, deleted via `deleteBlob` (a
// pure pass-through — blobs carry no OKF semantics of their own to enforce).
//
// `doc delete <id>` (doc.ts) stays the concept-native form for docs; this verb exists because blob
// addressing lives ONLY in the --doc-key family (mirrors the already-accepted `pull --doc-key x.md`
// vs `doc read` overlap) — a `--delete` flag bolted onto `promote`/`pull` was rejected as
// semantically muddy (those verbs move BYTES; this one REMOVES them, a different shape of command).
//
// Idempotent (AXI P6): deleting an ABSENT key is SUCCESS (`deleted:false`, exit 0), never
// NOT_FOUND. Hard-delete — no tombstone, non-cascading (other docs' links to/from the deleted id
// are left exactly as written; backlinks are derived, so a dangling reference simply stops
// resolving on the next graph walk), and does NOT append a `log.md` entry (no other engine write
// path self-logs either — D8).
import { parseArgs } from "node:util";
import { deleteDoc, deleteBlob, conceptIdFromPath, VersionConflict } from "@agentstate-lite/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError, classifyBundleError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode, type OutputMode } from "../output.js";
import { cliInvocation } from "../invocation.js";

export const DELETE_USAGE = `agentstate-lite delete — hard-delete a doc or blob by its key (symmetric with promote/pull)

Usage:
  agentstate-lite delete --doc-key <key> [options]

Routes by the --doc-key's target (checked case-insensitively), symmetric with 'promote'/'pull':
  A key ending '.md' is a DOC: id = the key minus '.md' — deleted through the engine. A reserved id
  (index.md/log.md) is rejected as USAGE regardless of this route — reserved files were never
  deletable.
  Any OTHER key is a BLOB: opaque bytes, deleted directly (no OKF semantics to enforce).

'doc delete <id>' (see 'agentstate-lite doc --help') is the concept-native form for docs; this verb
exists because blob addressing lives only in the --doc-key family.

Idempotent: deleting an ABSENT key is SUCCESS (deleted:false, exit 0), never NOT_FOUND. Hard-delete
— no tombstone, non-cascading (other docs' links to/from the deleted id are left exactly as
written), and does NOT append a log.md entry.

Options:
  --doc-key <key>          Key to delete (required) — ends '.md' -> doc route, else blob route
  --expected-version <v>   Compare-and-swap token from a prior read/write/pull receipt (a stale
                            token is a CONFLICT, exit 5; omit for an unconditional delete)
  --dir <path>              Bundle directory (default: discovered from the cwd)
  --remote <url>            Talk to a wire-protocol server instead of a local bundle (mutually
                            exclusive with --dir; remote access is always explicit)
  --json                    Emit compact JSON instead of TOON
  -h, --help                Show this help
`;

export interface DeleteCliDeps {
  stdout: (s: string) => void;
}

/** True when `key`'s final segment ends `.md`, checked CASE-INSENSITIVELY (B6) — mirrors `promote`/`pull`. */
function isDocRouteKey(key: string): boolean {
  return key.toLowerCase().endsWith(".md");
}

export async function deleteCommand(argv: string[], deps: Partial<DeleteCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          "doc-key": { type: "string" },
          "expected-version": { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.delete,
  );
  if (values.help) {
    stdout(DELETE_USAGE);
    return;
  }
  const key = values["doc-key"]?.trim();
  if (!key) {
    throw new CliError("USAGE", "--doc-key <key> is required", {
      help: `${cliInvocation()} delete --doc-key <key>`,
    });
  }

  // A PRESENT-but-blank `--expected-version` is a USAGE error, not "no CAS" — see the twin guard
  // in `doc delete` (doc.ts). Coercing a blank flag to `undefined` would SILENTLY downgrade an
  // intended compare-and-swap into an UNCONDITIONAL delete; the seam's own
  // `assertValidExpectedVersion` rejects `""`, and delete is the most destructive operation, so
  // fail loudly instead of removing bytes the caller meant to guard.
  const rawExpected = values["expected-version"];
  if (rawExpected !== undefined && rawExpected.trim() === "") {
    throw new CliError(
      "USAGE",
      "--expected-version was given an empty value — pass a real version token (from a prior read/write/pull receipt) or omit the flag for an unconditional delete.",
      { help: `${cliInvocation()} delete --doc-key ${key} --expected-version <v>` },
    );
  }

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const mode: OutputMode = resolveMode(values);
  const expectedVersion = rawExpected?.trim();
  const docRoute = isDocRouteKey(key);

  let deleted: boolean;
  try {
    if (docRoute) {
      // Canonicalize a case-insensitively-'.md' key (e.g. 'Report.MD', B6) before reusing
      // `conceptIdFromPath` (which strips '.md' case-SENSITIVELY) — mirrors `promote`/`pull`'s
      // identical canonicalization step exactly.
      const canonicalPath = key.slice(0, -3) + ".md";
      const id = conceptIdFromPath(canonicalPath);
      deleted = await deleteDoc(bundle, id, expectedVersion ? { expectedVersion } : undefined);
    } else {
      deleted = await deleteBlob(bundle, key, expectedVersion ? { expectedVersion } : undefined);
    }
  } catch (err) {
    throw deleteErrorToCliError(err, key, values.remote);
  }

  // AXI P6: deleting an ABSENT key is SUCCESS (deleted:false), never NOT_FOUND — exit 0 either way.
  const receipt: Record<string, unknown> = {
    delete: "deleted",
    route: docRoute ? "doc" : "blob",
    key,
    deleted,
  };
  receipt.help = [`${cliInvocation()} list`];
  stdout(render(receipt, mode));
}

/** Map a delete failure to a structured CliError, mirroring `promote`'s error-classification posture. */
function deleteErrorToCliError(err: unknown, key: string, remoteUrl?: string): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof VersionConflict) {
    return new CliError(
      "STALE_HEAD",
      `'${key}' has moved since --expected-version ${err.expected} was read (current: ` +
        `${err.actual ?? "absent"}) — re-read and retry with the current version.`,
      {
        help: `${cliInvocation()} delete --doc-key ${key} --expected-version ${err.actual ?? "<token>"}`,
        details: { expected: err.expected, actual: err.actual },
      },
    );
  }
  // Anything else lands on the one boundary: a typed InvalidInputError (reserved-id,
  // unsafe-id) → USAGE, a RemoteError by ITS code, an unexpected failure → RUNTIME.
  return classifyBundleError(err, remoteUrl);
}
