// `superbee pull --doc-key <key> --out (<path> | -)` — the out-of-band byte-OUT channel: the
// reverse of `promote`.
//
// ROUTES BY TARGET, symmetric with `promote` (A6, I8): a `--doc-key` ending `.md` (case-insensitive,
// B6) is a DOC — delivered as the CANONICAL OKF re-serialization via `readDocVersioned` + core's
// `stringifyDoc` (the ONE serializer), UNIFORMLY for both `--dir` and `--remote`. This is
// deliberately different from `doc read --out`'s LOCAL path (which streams raw on-disk bytes): `pull`
// is built fresh on the ENGINE API and is backend-agnostic by design. For an ENGINE-WRITTEN doc this
// is byte-identical to the original (`stringifyDoc` is exactly what `writeDoc` used to produce the
// on-disk bytes in the first place); a hand-edited file with idiosyncratic YAML formatting (unusual
// quoting, key order, comments) round-trips to the canonical form, not its original bytes — the SAME
// documented divergence `doc read --out --remote` already carries, now also true of `pull --dir` for
// docs (say so in the usage text, don't just leave it implicit).
//
// B7: NO byte-verification on the doc route. `FilesystemBackend`'s doc version is a hash of ON-DISK
// bytes, which is NOT generally equal to `stringifyDoc`'s canonical output for a hand-edited doc
// (`examples/sample-bundle`!) — a shared self-verify would hard-fail valid pulls, and verifying
// against `contentVersion` would be vacuous (it IS `stringifyDoc`'s hash by definition). The receipt
// instead reports the STORE's version token as-is — the exact CAS handle a follow-up
// `promote --expected-version` needs (A8a).
//
// Every OTHER key is a BLOB: raw bytes via `readBlob`, self-verified — `blobVersion(bytes)` must
// equal the version the backend reported. This IS a real, non-tautological check: `RemoteBackend`'s
// version rides the HTTP `ETag` (asserted by the SERVER), so comparing it against a CLIENT-side
// recomputation over the bytes that actually arrived catches transport corruption, not just a local
// adapter re-confirming its own promise.
//
// A3/I8: a pulled key's SAFETY when `--out` lands inside the open bundle depends on the RESOLVED OUT
// PATH's shape, not the route: a `.md`-shaped in-bundle path is re-ingested by the next concept
// walk (the SAME risk `doc read --out`'s F3 warning addresses — reused here verbatim, never a
// parallel copy) regardless of whether the bytes came from the doc or blob route; a non-`.md` path
// is inert. In the common/expected case a blob's own key naturally produces a non-'.md' `--out`
// path, so the warning does not "over-apply" to ordinary blob pulls — it only fires when the
// destination path itself looks like a concept doc.
import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import {
  readDocVersioned,
  readBlob,
  stringifyDoc,
  conceptIdFromPath,
  blobVersion,
  type Bundle,
} from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError, toExit, asHandled, classifyBundleError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode, renderErrorEnvelope, type OutputMode } from "../output.js";
import { cliInvocation } from "../invocation.js";
import { inBundlePollutionWarning, readErrorToCliError } from "./doc.js";

export const PULL_USAGE = `superbee pull — pull a doc or blob's bytes out of the store (the reverse of 'promote')

Usage:
  superbee pull --doc-key <key> --out (<path> | -) [options]

Routes by the --doc-key's target (case-insensitive), symmetric with 'promote':
  A key ending '.md' is a DOC: delivered as the CANONICAL OKF re-serialization (core's ONE
  serializer), for BOTH --dir and --remote. For an engine-written doc this is byte-identical to the
  original; a hand-edited file with unusual YAML formatting round-trips to the canonical form, not
  its original bytes. The receipt's 'version' is the store's CURRENT version token (no byte-verify
  on this route, B7) — pass it straight to a follow-up 'promote --expected-version' to update it
  safely.
  Any OTHER key is a BLOB: raw bytes, self-verified against the returned version (a real integrity
  check — catches transport corruption over --remote too, not just a local tautology).

--out - streams raw bytes to stdout; the receipt goes to STDERR instead (the byte stream stays
pure), and any error also routes to stderr in that mode. --out <path> writes the file and prints the
receipt to stdout. A destination path landing INSIDE an open LOCAL bundle carries a loud 'warning'
field when it resolves to a '.md' or reserved (index.md/log.md) filename — the SAME risk
'doc read --out' warns about — regardless of whether the pulled bytes came from the doc or blob
route; an ordinary blob's own key naturally avoids this (it is not '.md'-shaped), so the warning
does not fire for typical blob pulls.

Options:
  --doc-key <key>       Source key (required)
  --out <path>          Write bytes to this local path
  --out -               Stream raw bytes to stdout; receipt -> stderr
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --remote <url>        Talk to a wire-protocol server instead of a local bundle (mutually
                         exclusive with --dir; remote access is always explicit)
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help
`;

export interface PullCliDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  writeStdoutBytes: (data: Uint8Array) => void;
}

/** True when `key`'s final segment ends `.md`, checked CASE-INSENSITIVELY (B6) — mirrors `promote`. */
function isDocRouteKey(key: string): boolean {
  return key.toLowerCase().endsWith(".md");
}

/** Bytes + the route-specific receipt fields (in display order), BEFORE `out`/`warning`/`help` are added. */
interface PullResult {
  bytes: Uint8Array;
  fields: Record<string, unknown>;
}

async function pullDoc(bundle: Bundle, key: string, remoteUrl?: string): Promise<PullResult> {
  const canonicalPath = key.slice(0, -3) + ".md";
  const id = conceptIdFromPath(canonicalPath);
  let result: Awaited<ReturnType<typeof readDocVersioned>>;
  try {
    result = await readDocVersioned(bundle, id);
  } catch (err) {
    throw readErrorToCliError(err, id, remoteUrl);
  }
  const raw = stringifyDoc(result.doc.frontmatter, result.doc.body);
  const bytes = Buffer.from(raw, "utf8");
  return {
    bytes,
    fields: {
      route: "doc",
      id: result.doc.id,
      type: result.doc.frontmatter.type,
      version: result.version,
      size_bytes: bytes.byteLength,
    },
  };
}

async function pullBlob(bundle: Bundle, key: string, remoteUrl?: string): Promise<PullResult> {
  let result: Awaited<ReturnType<typeof readBlob>>;
  try {
    result = await readBlob(bundle, key);
  } catch (err) {
    throw classifyBundleError(err, remoteUrl);
  }
  if (result === null) {
    throw new CliError("NOT_FOUND", `no blob at key '${key}'`, {
      help: `${cliInvocation()} promote <file> --doc-key ${key}`,
    });
  }
  const actual = blobVersion(result.bytes);
  if (actual !== result.version) {
    throw new CliError(
      "INTEGRITY_MISMATCH",
      `pulled bytes for '${key}' hash to ${actual}, but the store reported ${result.version} — the ` +
        `transfer may have been corrupted; retry the pull`,
      { details: { expected: result.version, actual } },
    );
  }
  return {
    bytes: result.bytes,
    fields: {
      route: "blob",
      content_type: result.contentType,
      version: result.version,
      size_bytes: result.bytes.byteLength,
    },
  };
}

export async function pull(argv: string[], deps: Partial<PullCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const writeStdoutBytes = deps.writeStdoutBytes ?? ((d: Uint8Array) => void process.stdout.write(d));

  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          "doc-key": { type: "string" },
          out: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.pull,
  );
  if (values.help) {
    stdout(PULL_USAGE);
    return;
  }
  const key = values["doc-key"]?.trim();
  if (!key) {
    throw new CliError("USAGE", "--doc-key <key> is required", {
      help: `${cliInvocation()} pull --doc-key <key> --out <path>`,
    });
  }
  const out = values.out?.trim();
  if (!out) {
    throw new CliError("USAGE", "--out (<path> | -) is required", {
      help: `${cliInvocation()} pull --doc-key ${key} --out <path>`,
    });
  }

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const mode: OutputMode = resolveMode(values);
  const streamMode = out === "-";
  const docRoute = isDocRouteKey(key);

  const runToTarget = async (): Promise<void> => {
    const result = docRoute ? await pullDoc(bundle, key, values.remote) : await pullBlob(bundle, key, values.remote);
    const receipt: Record<string, unknown> = { pull: "read", key, ...result.fields, out };

    // A10: pull's receipt hints a ready-to-paste `promote --expected-version <token>` with the
    // CURRENT token inline, so the edit-iterate loop never needs a second discovery call. Streaming
    // mode has no known destination file to reference (bytes went to stdout, presumably piped
    // elsewhere) — a placeholder makes the shape of the follow-up command clear regardless.
    const version = result.fields.version as string;
    const fileHint = streamMode ? "<file>" : out;
    receipt.help = [`${cliInvocation()} promote ${fileHint} --doc-key ${key} --expected-version ${version}`];

    if (streamMode) {
      writeStdoutBytes(result.bytes);
      stderr(render(receipt, mode));
      return;
    }
    // F3-shaped warning (reused verbatim, never a parallel copy) — fires whenever the RESOLVED out
    // path looks like a concept doc / reserved filename inside an open local bundle, regardless of
    // which route produced the bytes (see file header).
    const warning = inBundlePollutionWarning(bundle, out);
    if (warning) receipt.warning = warning;
    await fs.writeFile(out, result.bytes);
    stdout(render(receipt, mode));
  };

  if (!streamMode) {
    await runToTarget();
    return;
  }

  // --out -: route any error envelope to STDERR (stdout is reserved for raw bytes), then rethrow as
  // `handled` so the bin wrapper sets the exit code WITHOUT re-emitting the envelope on stdout —
  // mirrors `doc read --out -`'s full purity dance exactly (I5).
  try {
    await runToTarget();
  } catch (err) {
    const { envelope } = toExit(err);
    stderr(renderErrorEnvelope(envelope));
    throw asHandled(err);
  }
}
