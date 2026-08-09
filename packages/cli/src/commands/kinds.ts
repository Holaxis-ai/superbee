// `agentstate-lite kinds` — list the kind conventions declared by this bundle.
//
// Phase-0 experiment result (binding — see `docs/plan-kind-conventions.md` Part B): agents given NO
// enumeration path scored 0/3 on discovery of a bundle's declared kinds (~49-command probe spirals,
// one silently-wrong artifact); agents given a dedicated `kinds` verb scored 3/3, zero failures, 3
// commands. This command IS that verb — the live-registry counterpart to `--help`/`home`'s static
// pointer line (reference.ts kindsPointer()), which stays offline/no-I/O by AXI contract.
import { parseArgs } from "node:util";
import { freshnessHorizonMs, loadKinds, type KindConvention } from "@agentstate-lite/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { leafArity, parseOrUsage } from "../args.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation } from "../invocation.js";

export const KINDS_USAGE = `agentstate-lite kinds — list the kind conventions declared by this bundle

Usage:
  agentstate-lite kinds [--dir <path>] [--remote <url>]

A kind convention is a plain OKF doc (type: Convention) under conventions/ declaring a document
kind's purpose, required/optional fields and their descriptions, allowed enum values, typed-link vocabulary, expected body
sections, and an optional freshness horizon. See 'agentstate-lite new --help' to create an
instance of a declared kind.

Declaring a kind convention (frontmatter keys core reads — everything else is unread prose):
  governs              string   required — the 'type' value this convention governs
  title                string   optional — display title (defaults to governs)
  description          string   optional — the kind's purpose and intended use
  path                 string   optional — bundle-relative path prefix for instances
  fields.required      list     field names an instance MUST carry
  fields.optional      list     field names an instance MAY carry
  fields.descriptions  map      field name -> human guidance for a declared field
  fields.values        map      field name -> list of allowed values — the ONLY place an enum
                                 constraint goes; never a top-level enum/enums/values/constraints key
  fields.value_descriptions
                        map      enum field -> allowed value -> human guidance. Guidance only; it
                                 does not add transitions, guards, aliases, or validation behavior
  fields.terminal      map      field name -> subset of that field's values marking an instance
                                 "done" (e.g. status: [done, canceled]). A field named here SHOULD
                                 also be declared in fields.values (a coherence warning otherwise);
                                 a value named here that isn't one of that field's allowed values
                                 also warns. Drives 'list --open' (excludes terminal instances) and
                                 the 'status' command's missing_expected_links sweep (excludes them
                                 from the count/rows and its sort)
  links                map      link type name -> allowed TARGET kind, for typed edges instances
                                 of this kind may carry as link SOURCE (e.g. contains: Task). A
                                 link whose display text exactly matches a declared type is a
                                 typed edge; every other link is an untyped citation. Write typed
                                 edges with 'link add <from> <to> --text <type>' and query them
                                 with 'link show <id> --text <type>'
  link_descriptions    map      link type name -> human guidance for a relationship declared in
                                 this kind's links map. Guidance only; it adds no link requirement
                                 or graph-validation behavior
  expects_inbound      map      link type name -> expected SOURCE kind, declared on the kind the
                                 expectation is ABOUT (the link TARGET) — e.g. a 'Task' declaring
                                 {contains: "Roadmap Item"} expects every Task to have an inbound
                                 'contains' edge from a Roadmap Item. Drives the 'status' command's
                                 missing_expected_links lint; 'link add' also warns on a
                                 type-mismatched edge against any declared 'links'/'expects_inbound'
                                 vocabulary. Write-time is never blocked by this key.
  sections             list     expected body-section names; 'kinds' preserves these names in its
                                 sections output and also emits required_headings with the exact
                                 level-1 Markdown syntax (for example '# Requested decision')
  freshness_horizon    string   '<n>(m|h|d)', e.g. 24h, 30d, 15m
A misshaped or misplaced key here is a non-fatal registry warning (visible in 'kinds'/'status'
output), never a silent no-op. See 'agentstate-lite doc read conventions/context-note' on any
--init'd bundle for a full worked example with a values: enum and sections:.

Options:
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --remote <url>        Talk to a wire-protocol server instead of a local bundle
                         (mutually exclusive with --dir; remote access is always explicit)
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help
`;

export interface KindsCliDeps {
  stdout: (s: string) => void;
}

/** Project one KindConvention into the flat row shape `kinds` renders. */
function toRow(kind: KindConvention): Record<string, unknown> {
  const row: Record<string, unknown> = {
    governs: kind.governs,
    required: kind.fields.required,
    optional: kind.fields.optional,
  };
  if (kind.description) row.description = kind.description;
  if (Object.keys(kind.fields.descriptions).length > 0) row.descriptions = kind.fields.descriptions;
  if (Object.keys(kind.fields.values).length > 0) row.values = kind.fields.values;
  if (Object.keys(kind.fields.valueDescriptions ?? {}).length > 0) {
    row.value_descriptions = kind.fields.valueDescriptions;
  }
  if (Object.keys(kind.fields.terminal).length > 0) row.terminal = kind.fields.terminal;
  if (kind.links && Object.keys(kind.links).length > 0) row.links = kind.links;
  if (kind.linkDescriptions && Object.keys(kind.linkDescriptions).length > 0) {
    row.link_descriptions = kind.linkDescriptions;
  }
  if (kind.expectsInbound && Object.keys(kind.expectsInbound).length > 0) row.expects_inbound = kind.expectsInbound;
  if (kind.path) row.path = kind.path;
  if (kind.sections && kind.sections.length > 0) {
    // Keep `sections` as the stable semantic names and also project the exact Markdown an author
    // must write. The latter prevents a bare name such as "Requested decision" from leaving the
    // required heading level implicit to an agent or human composing a body outside `new`.
    row.sections = kind.sections;
    row.required_headings = kind.sections.map((section) => `# ${section}`);
  }
  if (kind.freshnessHorizon) {
    row.horizon = kind.freshnessHorizon;
    const ms = freshnessHorizonMs(kind);
    if (ms !== undefined) row.horizon_ms = ms;
  }
  return row;
}

export async function kinds(argv: string[], deps: Partial<KindsCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values } = parseOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    "kinds",
    leafArity("kinds"),
  );
  if (values.help) {
    stdout(KINDS_USAGE);
    return;
  }

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const registry = await loadKinds(bundle);
  const rows = [...registry.kinds.values()].sort((a, b) => a.governs.localeCompare(b.governs)).map(toRow);

  const out: Record<string, unknown> = { count: rows.length, kinds: rows };
  if (registry.warnings.length > 0) out.warnings = registry.warnings;
  if (rows.length === 0) {
    out.help = [`${cliInvocation()} new "<Kind>" <id> --<field> <value>  (once a kind is declared)`];
  }
  stdout(render(out, resolveMode(values)));
}
