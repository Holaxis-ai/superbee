// Thin dispatcher for the generic OKF document verbs. Per-verb behavior lives in `./doc/*.ts`;
// shared usage, stdin detection, and error classification live in `./doc/common.ts`. Re-exports
// preserve this module's public import surface.
//
// `doc write` accepts `--body`, `--body-file`, or real non-empty stdin. Overwriting an existing
// non-empty body with no body source is refused unless `--blank-body` explicitly opts in; new docs
// may still have empty bodies. Stdin is considered real only for a FIFO, regular file, or connected
// socket. TTYs, character devices, errors, and empty pipes do not imply an explicit body. Use
// `--body ""` for an explicit empty body.
//
// `doc update` is a versioned field patch: it preserves omitted fields, validates the resulting
// kind, refreshes timestamps by default, and uses bounded CAS retry. A field-bearing patch never
// probes stdin, because an agent harness may hold a genuine pipe open indefinitely. Stdin remains
// available as the sole patch source when no field flags were supplied.
//
// A `doc read` detail render publishes a truncated body as `body_preview`, marked inside the value
// itself. Writing that preview back through `doc write`/`doc update` is refused unless
// `--accept-truncated-body` opts in, so a preview cannot silently become a document's whole body.
//
// `doc read --out` preserves raw bytes; `--body-out` pairs the body with the same read's version for
// a guarded follow-up update; `--rendered-out` emits inert HTML through the canonical bounded
// renderer. Raw stdout keeps receipts on stderr. A local output path inside the open bundle is
// allowed but warned because the next bundle walk may ingest it as a document.
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { DOC_USAGE, type DocCliDeps } from "./doc/common.js";
import type { UiCliDeps } from "./ui.js";
import { docWrite } from "./doc/write.js";
import { docUpdate } from "./doc/update.js";
import { docRead } from "./doc/read.js";
import { docHistory } from "./doc/history.js";
import { docDelete } from "./doc/delete.js";
import { docOpen } from "./doc/open.js";

export { DOC_USAGE, type DocCliDeps, readErrorToCliError } from "./doc/common.js";
export { inBundlePollutionWarning } from "./egress.js";

export async function doc(argv: string[], deps: Partial<DocCliDeps & UiCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "write") return docWrite(rest, deps);
  if (sub === "update") return docUpdate(rest, deps);
  if (sub === "read") return docRead(rest, deps);
  if (sub === "open") return docOpen(rest, deps);
  if (sub === "history") return docHistory(rest, deps);
  if (sub === "delete") return docDelete(rest, deps);
  if (sub === "-h" || sub === "--help" || sub === undefined) {
    stdout(DOC_USAGE);
    return;
  }
  if (sub === "create") {
    const invocation = cliInvocation();
    throw new CliError(
      "USAGE",
      `'doc create' is not a command; use '${invocation} new "<Kind>" <id> ...' for governed, strict, ` +
        `create-only authoring, or '${invocation} doc write <id> --type <Type> ...' for generic document ` +
        "creation or full replacement",
      { help: `${invocation} doc --help` },
    );
  }
  throw new CliError("USAGE", `unknown doc subcommand: ${sub} (expected write|update|read|open|history|delete)`, {
    help: `${cliInvocation()} doc --help`,
  });
}
