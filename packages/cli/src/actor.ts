import { CliError } from "./errors.js";
import { LEGACY_ACTOR_ENV, SUPERBEE_ACTOR_ENV, resolveCompatibleScalarEnv } from "./env-policy.js";

export const ACTOR_ENV = LEGACY_ACTOR_ENV;
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
    return resolveCompatibleScalarEnv({
      canonical: SUPERBEE_ACTOR_ENV,
      legacy: ACTOR_ENV,
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
