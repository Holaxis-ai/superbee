import { CliError } from "./errors.js";

export const SUPERBEE_ACTOR_ENV = "SUPERBEE_ACTOR";
export const SUPERBEE_NO_UPDATE_CHECK_ENV = "SUPERBEE_NO_UPDATE_CHECK";
/** The agent a hosted sync names for its writes (`X-Superbee-Via`), such as `codex`. */
export const SUPERBEE_VIA_ENV = "SUPERBEE_VIA";
/** Any value: a hosted sync names no agent, even under Claude Code. */
export const SUPERBEE_NO_VIA_ENV = "SUPERBEE_NO_VIA";

export interface ScalarEnvOptions {
  name: string;
  label: string;
  env?: Readonly<Record<string, string | undefined>>;
  help?: string;
  requireNonEmpty?: boolean;
}

/** A trimmed scalar from one environment variable; a blank value is absent unless refused. */
export function resolveScalarEnv(opts: ScalarEnvOptions): string | undefined {
  const env = opts.env ?? process.env;
  if (!Object.hasOwn(env, opts.name)) return undefined;
  const value = (env[opts.name] ?? "").trim();
  if (value === "" && opts.requireNonEmpty) {
    throw new CliError(
      "USAGE",
      `${opts.name} was given an empty value - pass a ${opts.label} or unset the environment variable.`,
      opts.help ? { help: opts.help } : {},
    );
  }
  return value === "" ? undefined : value;
}
