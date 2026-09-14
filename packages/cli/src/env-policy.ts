import { CliError } from "./errors.js";

export const SUPERBEE_ACTOR_ENV = "SUPERBEE_ACTOR";
export const LEGACY_ACTOR_ENV = "AGENTSTATE_LITE_ACTOR";
export const SUPERBEE_API_KEY_ENV = "SUPERBEE_API_KEY";
export const LEGACY_API_KEY_ENV = "AGENTSTATE_LITE_API_KEY";
export const SUPERBEE_NO_UPDATE_CHECK_ENV = "SUPERBEE_NO_UPDATE_CHECK";
export const LEGACY_NO_UPDATE_CHECK_ENV = "ASLITE_NO_UPDATE_CHECK";

export interface CompatibleScalarEnvOptions {
  canonical: string;
  legacy: string;
  label: string;
  env?: Readonly<Record<string, string | undefined>>;
  help?: string;
  requireNonEmpty?: boolean;
}

function hasOwn(env: Readonly<Record<string, string | undefined>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

export function resolveCompatibleScalarEnv(opts: CompatibleScalarEnvOptions): string | undefined {
  const env = opts.env ?? process.env;
  const present = [opts.canonical, opts.legacy]
    .filter((name) => hasOwn(env, name))
    .map((name) => ({ name, value: (env[name] ?? "").trim() }));
  if (!present.length) return undefined;

  const empty = present.filter((entry) => entry.value === "");
  if (opts.requireNonEmpty && empty.length) {
    const sources = empty.map((entry) => entry.name).join(" and ");
    throw new CliError(
      "USAGE",
      `${sources} ${empty.length === 1 ? "was" : "were"} given an empty value - pass a ${opts.label} or unset the environment variable.`,
      opts.help ? { help: opts.help } : {},
    );
  }

  const valued = present.filter((entry) => entry.value !== "");
  if (!valued.length) return undefined;
  const first = valued[0]?.value;
  if (first !== undefined && valued.some((entry) => entry.value !== first)) {
    throw new CliError(
      "USAGE",
      `${opts.canonical} and ${opts.legacy} specify different ${opts.label} values; unset one or make them identical.`,
      opts.help ? { help: opts.help } : {},
    );
  }
  return first;
}
