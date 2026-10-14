// Shared write plumbing for the bundle's own declaration documents (`docs/bundle` via
// `bundle id set`, `docs/dependencies` via `deps add|remove`). No Kind governs either document, so
// the generic field verbs cannot set their fields; these verbs own the field semantics and reach
// the store only through `mutateDoc`, like every other CLI writer.
import type { Bundle } from "@superbee/core";

import {
  assertResolvedLocalRouteIdentity,
  boardAttributionForRoute,
  openBundle,
  resolveLocalBundleRoute,
  resolveRemoteFlag,
  type ResolvedLocalRoute,
} from "./bundle.js";
import { boardPostPersistHook } from "./board-attribution.js";
import { commandToken } from "./command-text.js";
import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import type { MutateErrorHooks } from "./mutate.js";

export interface DeclarationTarget {
  bundle: Bundle;
  route: ResolvedLocalRoute | undefined;
  remoteUrl: string | undefined;
}

/** The same bundle selection `doc update` makes: `--remote`, else the resolved local route. */
export async function openDeclarationTarget(dir: string | undefined, remoteFlag: string | undefined): Promise<DeclarationTarget> {
  const remoteUrl = await resolveRemoteFlag(remoteFlag, dir);
  const route = remoteUrl === undefined ? await resolveLocalBundleRoute(dir) : undefined;
  const bundle = route?.bundle ?? (await openBundle(dir, remoteUrl));
  if (route) await assertResolvedLocalRouteIdentity(route);
  return { bundle, route, remoteUrl };
}

/** The board self-attribution hook for a substantive write, decided before persistence. */
export function declarationPersistHook(target: DeclarationTarget, actor: string | undefined): (() => Promise<void>) | undefined {
  return boardPostPersistHook(target.route ? boardAttributionForRoute(target.route) : { kind: "none" }, actor);
}

/** A present-but-blank `--expected-version` is a USAGE error, never a silent downgrade to no CAS. */
export function expectedVersionFlag(value: string | undefined, help: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new CliError("USAGE", "--expected-version was given an empty value — pass a version token from a prior receipt or omit the flag.", { help });
  }
  return trimmed;
}

/**
 * STALE_HEAD for a moved document. Under --expected-version it names that premise; without one the
 * bounded retry lost every race to concurrent writers, so it says so and hands back the command.
 */
export function declarationErrorHooks(id: string, cas: { expectedVersion: string | undefined; retry: string }): MutateErrorHooks {
  return {
    notFound: () => new CliError("NOT_FOUND", `no document at id '${id}'`, { help: `${cliInvocation()} doc read ${commandToken(id)}` }),
    staleHead: (err) =>
      cas.expectedVersion === undefined
        ? new CliError(
            "STALE_HEAD",
            `'${id}' changed concurrently on every attempt (moved since ${err.expected ?? "absent"}; now ${err.actual ?? "absent"}) — retries exhausted; re-run the command.`,
            { help: cas.retry, details: { expected: err.expected, actual: err.actual } },
          )
        : new CliError(
            "STALE_HEAD",
            `'${id}' has moved since --expected-version ${commandToken(cas.expectedVersion)} was read (current: ${err.actual ?? "absent"}) — re-read and retry with the current version.`,
            { help: `${cliInvocation()} doc read ${commandToken(id)}`, details: { expected: err.expected, actual: err.actual } },
          ),
  };
}

/**
 * ` --flag <value>` for every flag the caller gave, each value shell-quoted by the quoting
 * authority, so a printed re-run command writes exactly what the original invocation asked for.
 */
export function givenFlags(flags: ReadonlyArray<readonly [flag: string, value: string | boolean | undefined]>): string {
  return flags
    .map(([flag, value]) => (value === undefined || value === false ? "" : value === true ? ` --${flag}` : ` --${flag} ${commandToken(value)}`))
    .join("");
}

export const DECLARATION_COMMON_OPTIONS = `  --expected-version <v>  Compare-and-swap: write only if the document is still at this version
                          (from a prior receipt or 'doc read'); a missing document has no version
  --actor <name>       Attribute the write (overrides SUPERBEE_ACTOR; legacy AGENTSTATE_LITE_ACTOR
                       remains supported). OKF v0.2 bundles accept only an OKF actor: human:<id>,
                       process:<id>, or <producer>/<version> (e.g. openai/codex)
  --dir <path>         Bundle directory (default: discovered from the cwd)
  --remote <url>       Talk to a wire-protocol server instead of a local bundle
                       (mutually exclusive with --dir)
  --json               Emit compact JSON instead of TOON
  -h, --help           Show this help`;
