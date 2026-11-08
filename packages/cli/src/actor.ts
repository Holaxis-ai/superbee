import { isOkfActor, readBundleOkfVersion, type Bundle } from "@superbee/core";
import { CliError } from "./errors.js";
import { actorRefusal } from "./actor-guidance.js";
import { SUPERBEE_ACTOR_ENV, resolveScalarEnv } from "./env-policy.js";

export { SUPERBEE_ACTOR_ENV };

export interface ResolveActorOptions {
  /** Injectable for deterministic tests; commands use process.env. */
  env?: NodeJS.ProcessEnv;
  /** Caller-specific fixing command for a blank explicit flag/environment value. */
  help?: string;
}

/** Resolve advisory attribution once at the CLI boundary: explicit flag > environment > absent. */
export function resolveActor(explicit: string | undefined, opts: ResolveActorOptions = {}): string | undefined {
  if (explicit === undefined) {
    return resolveScalarEnv({
      name: SUPERBEE_ACTOR_ENV,
      label: "actor identity",
      env: opts.env,
      help: opts.help,
      requireNonEmpty: true,
    });
  }
  const actor = explicit.trim();
  if (!actor) {
    throw new CliError(
      "USAGE",
      "--actor was given an empty value — pass an actor identity or omit the flag.",
      opts.help ? { help: opts.help } : {},
    );
  }
  return actor;
}

/**
 * Refuse a non-conforming actor BEFORE a verb's first write, for verbs whose first write is not
 * the document mutation that would otherwise raise `OkfActorError` (artifact create promotes a
 * blob first; index generate writes reserved files that never pass the seam; recipe evolve wraps
 * write-policy errors as CONFLICT). One reserved read of the edition; a v0.1 bundle keeps
 * free-form actors. The refusal wording is the same self-correcting one every other verb emits.
 */
export async function assertActorAcceptedByBundle(bundle: Bundle, actor: string | undefined): Promise<void> {
  if (actor === undefined) return;
  const edition = (await readBundleOkfVersion(bundle)) ?? "0.1";
  if (edition !== "0.2" || isOkfActor(actor)) return;
  const refusal = actorRefusal(actor);
  throw new CliError("USAGE", refusal.message, { help: refusal.help, details: { actor } });
}
