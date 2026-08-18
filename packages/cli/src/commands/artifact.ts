// `superbee artifact create <file> --title <title>` — the ONE command that owns the
// produced-output sequence (designs/artifact-runtime Unit 1): derive a collision-safe id, promote
// the bytes to `artifacts/<id>.html` (capturing the version in-process — the agent never sees a
// hash), and create-only the `type: Artifact` record with `entry` + `entry_version` + logical
// workflow state `active`. `--supersedes <id>` additionally flips the prior artifact to
// `superseded` and links this
// one `supersedes` it.
//
// Order is derive-id → promote → record (blob-FIRST is required: the blob's version is only known
// after writing it, and a remote backend's version token is NOT locally computable). The failure
// contract, then: the collision-safe id considers existing blob keys too, so a re-run after a failed
// record-create picks a FRESH id and is never bricked; and a record-create failure NAMES the orphaned
// blob and points at recovery — never a SILENT orphan. `--supersedes` is validated UPFRONT (an
// existing artifacts/ Artifact), so a bad target rejects before any write.
//
// Admission (rendering) is product-level and convention-INDEPENDENT (designs/artifact-runtime,
// "product kind + opt-in convention"): this command works whether or not a bundle declares the
// Artifact Convention — strict validation applies only when it does. This is NOT a thin alias for
// the generic path (the reason `note` was deleted): it owns a fumble-prone multi-step sequence.
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  loadKinds,
  progressStatusStorageField,
  queryHeads,
  listBlobs,
  readDoc,
  writeBlob,
  type Bundle,
  type Frontmatter,
} from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { mutateDoc } from "../mutate.js";
import { boardPostPersistHook } from "../board-attribution.js";
import { resolveActor } from "../actor.js";
import { render, type OutputMode } from "../output.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { assertPathOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { resolveConceptIdCliArgument } from "../concept-id.js";

export const ARTIFACT_USAGE = `superbee artifact — produced outputs you share with a human (HTML today)

Usage:
  superbee artifact create <file> --title <title> [options]

'create' owns the whole sequence: it promotes <file>'s bytes under artifacts/, captures the version,
derives a collision-safe id from the title, and writes the type:Artifact record (entry, entry_version,
workflow state: active). One command — no version hash to copy, no two-object dance.

Options:
  --title <title>       REQUIRED — the artifact's human title (and the basis for its id)
  --description <text>  Optional one-line description
  --supersedes <id>     Mark a prior artifact superseded and link this one 'supersedes' it
  --dir <path>          Operate on a local bundle at <path>
  --remote <url>        Operate on a remote bundle
  --actor <name>        Attribute the write to <name>
  --json                TOON/JSON receipt
  -h, --help            Show this help`;

const ARTIFACT_CREATE_OPTIONS = {
  title: { type: "string" },
  description: { type: "string" },
  supersedes: { type: "string" },
  dir: { type: "string" },
  remote: { type: "string" },
  actor: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export interface ArtifactCliDeps {
  stdout: (s: string) => void;
}

/** Title → a bundle-relative slug (lowercase, hyphen-joined, bounded); never empty. Pure. */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "artifact";
}

/** The first free `artifacts/<slug>[-n]` record id (n starts at 2), given the ids already present. Pure. */
export function firstFreeId(slug: string, taken: ReadonlySet<string>): string {
  let id = `artifacts/${slug}`;
  for (let n = 2; taken.has(id); n++) id = `artifacts/${slug}-${n}`;
  return id;
}

export async function artifact(argv: string[], deps: Partial<ArtifactCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const sub = argv[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    stdout(ARTIFACT_USAGE);
    return;
  }
  if (sub !== "create") {
    throw new CliError("USAGE", `unknown artifact subcommand: '${sub}' (expected 'create')`, {
      help: `${cliInvocation()} artifact --help`,
    });
  }

  const { values, positionals } = parseLeafOrUsage(
    () => parseArgs({ args: argv.slice(1), strict: true, allowPositionals: true, options: ARTIFACT_CREATE_OPTIONS }),
    CLI_LEAVES.artifactCreate,
  );
  if (values.help) {
    stdout(ARTIFACT_USAGE);
    return;
  }

  const file = positionals[0] as string | undefined;
  if (!file) {
    throw new CliError("USAGE", "artifact create requires a local <file> positional", {
      help: `${cliInvocation()} artifact create <file> --title <title>`,
    });
  }
  // The byte channel must not carry private operational state into publishable bundle content.
  assertPathOutsidePrivateState(path.resolve(file));
  const title = (values.title as string | undefined)?.trim();
  if (!title) {
    throw new CliError("USAGE", "artifact create requires --title <title>", {
      help: `${cliInvocation()} artifact create ${file} --title <title>`,
    });
  }

  // Read the bytes ONCE, before any write — a missing/unreadable file is caller input and must leave
  // nothing created.
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new CliError("USAGE", `no such file: '${file}'`, {
        help: `${cliInvocation()} artifact create <file> --title <title>`,
      });
    }
    throw new CliError("RUNTIME", `could not read '${file}': ${err instanceof Error ? err.message : String(err)}`);
  }

  const mode: OutputMode = values.json ? "json" : "default";
  const dir = values.dir as string | undefined;
  const remoteUrl = values.remote as string | undefined;
  const actor = resolveActor(values.actor as string | undefined, {
    help: `${cliInvocation()} artifact create <file> --title <title> --actor <name>`,
  });
  const bundle: Bundle = await openBundle(dir, await resolveRemoteFlag(remoteUrl, dir));
  const registry = await loadKinds(bundle);

  // Validate --supersedes UPFRONT, before any write: it must be an existing artifacts/ Artifact. This
  // keeps the same-directory 'supersedes' link correct AND guarantees a real Artifact is the doc that
  // gets flipped — a cross-dir or non-Artifact target is a caller error, rejected before we touch the
  // store rather than silently writing a dangling edge.
  const rawSupersedes = (values.supersedes as string | undefined)?.trim();
  const supersedes = rawSupersedes
    ? await resolveConceptIdCliArgument(bundle, rawSupersedes)
    : undefined;
  if (supersedes) {
    if (!supersedes.startsWith("artifacts/")) {
      throw new CliError("USAGE", `--supersedes must be an artifacts/ id (got '${supersedes}')`, {
        help: `${cliInvocation()} list --type Artifact`,
      });
    }
    let prior;
    try {
      prior = await readDoc(bundle, supersedes);
    } catch {
      prior = undefined;
    }
    if (!prior) {
      throw new CliError("USAGE", `--supersedes target '${supersedes}' does not exist`, {
        help: `${cliInvocation()} list --type Artifact`,
      });
    }
    if (String(prior.frontmatter.type) !== "Artifact") {
      throw new CliError("USAGE", `--supersedes target '${supersedes}' is type '${prior.frontmatter.type}', not Artifact`, {
        help: `${cliInvocation()} list --type Artifact`,
      });
    }
  }
  // Both docs live under artifacts/, so the supersedes edge is a same-directory relative link.
  const body = supersedes ? `[supersedes](${supersedes.slice("artifacts/".length)}.md)\n` : "";

  // Derive a collision-safe id whose RECORD *and* BLOB key are both free. Considering existing blob
  // keys (not just record ids) is what stops a re-run after an orphaned blob from bricking on the
  // stray blob's expect-absent conflict: the re-run simply picks the next free slug.
  const [recordHeads, blobKeys] = await Promise.all([
    queryHeads(bundle, { prefix: "artifacts/" }),
    listBlobs(bundle, "artifacts/"),
  ]);
  const taken = new Set<string>([
    ...recordHeads.map((h) => h.id),
    ...blobKeys.map((k) => k.replace(/\.[^/.]+$/, "")),
  ]);
  const id = firstFreeId(slugifyTitle(title), taken);
  const entryKey = `${id}.html`;

  // 1. Promote the bytes (expect-absent create — the blob key is fresh by construction of the id).
  let entryVersion: string;
  try {
    entryVersion = await writeBlob(bundle, entryKey, bytes, "text/html", { expectedVersion: null });
  } catch (err) {
    throw new CliError("RUNTIME", `could not write the artifact blob '${entryKey}': ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Create the record (create-only CAS; strict validation applies only if an Artifact convention is declared).
  const frontmatter: Frontmatter = { type: "Artifact", title, entry: entryKey, entry_version: entryVersion };
  const description = (values.description as string | undefined)?.trim();
  if (description) frontmatter.description = description;
  let createdId: string;
  try {
    const result = await mutateDoc({
      bundle,
      id,
      mode: "create-only",
      registry,
      remoteUrl,
      strict: true,
      helpOnKindReject: `${cliInvocation()} kinds`,
      actor,
      persistActor: true,
      onPersisted: boardPostPersistHook(bundle, actor),
      buildCandidate: (_existing, context) => ({
        frontmatter: {
          ...frontmatter,
          [progressStatusStorageField(context.okfVersion)!]: "active",
        },
        body,
      }),
      errors: {
        // The id is free by construction (record + blob both checked), so this only fires on a race
        // with a concurrent writer. The catch below owns the orphaned-blob note uniformly.
        alreadyExists: () => new CliError("ALREADY_EXISTS", `'${id}' was created concurrently by another writer.`),
      },
    });
    createdId = result.doc.id;
  } catch (err) {
    // The blob is written but the record is not — NAME the orphan and point at recovery. mutateDoc
    // always throws a CliError, so we preserve its code (exit taxonomy) and APPEND the orphan context
    // rather than rethrowing it untouched. A re-run
    // picks a fresh id (the orphan's blob key is now 'taken'); the stray bytes stay deletable.
    const code = err instanceof CliError ? err.code : "RUNTIME";
    const why = err instanceof Error ? err.message : String(err);
    throw new CliError(
      code,
      `${why}\nThe blob '${entryKey}' was written but its record '${id}' was NOT — those bytes are orphaned. Re-run 'artifact create' (it picks a fresh id), or remove them with '${cliInvocation()} delete --doc-key ${entryKey}'.`,
      { help: `${cliInvocation()} delete --doc-key ${entryKey}` },
    );
  }

  // 3. Supersede the prior — NON-fatal: the new artifact (and its link) are already written, so a
  // failure here NAMES itself in the receipt rather than losing the create.
  let supersedeNote: string | undefined;
  if (supersedes) {
    try {
      await mutateDoc({
        bundle,
        id: supersedes,
        mode: "patch",
        registry,
        remoteUrl,
        strict: false,
        helpOnKindReject: `${cliInvocation()} kinds`,
        actor,
        persistActor: true,
        onPersisted: boardPostPersistHook(bundle, actor),
        buildCandidate: (existingDoc, context) => {
          // patch mode guarantees the target exists; narrow it so the required Frontmatter.type carries over.
          if (!existingDoc) throw new CliError("NOT_FOUND", `'${supersedes}' does not exist`);
          return {
            frontmatter: {
              ...existingDoc.frontmatter,
              [progressStatusStorageField(context.okfVersion)!]: "superseded",
            },
            body: existingDoc.body,
          };
        },
        errors: {},
      });
    } catch (err) {
      supersedeNote = `FAILED to mark '${supersedes}' superseded: ${err instanceof Error ? err.message : String(err)} — the new artifact and its 'supersedes' link are written; inspect '${supersedes}' and retry the update using its declared workflow field.`;
    }
  }

  const receipt: Record<string, unknown> = {
    artifact: "created",
    id: createdId,
    entry: entryKey,
    entry_version: entryVersion,
    content_type: "text/html",
    status: "active",
  };
  if (supersedes) receipt.supersedes = supersedeNote ?? supersedes;
  // The in-shell viewer (?view=artifact) ships in designs/artifact-runtime Unit 2 — don't advertise a
  // route that doesn't resolve yet (AXI honesty). Until then, pull the bytes out to view them.
  receipt.help = [
    `${cliInvocation()} doc read ${createdId}`,
    `${cliInvocation()} pull --doc-key ${entryKey} --out ${id.split("/").pop()}.html   # then open it (in-shell viewer: Unit 2)`,
  ];
  stdout(render(receipt, mode));
}
