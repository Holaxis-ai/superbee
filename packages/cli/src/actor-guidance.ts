/**
 * Actor guidance the CLI ships on every host: the help-line sentence, the self-correcting refusal,
 * and the `home` orientation line. Depends only on core's one grammar and suggestion rule, so
 * `errors.ts` can present a refusal without a circular import through `actor.ts`.
 */
import { OKF_ACTOR_FORMS, isOkfActor, suggestOkfActor } from "@superbee/core";
import { commandLiteral, commandToken } from "./command-text.js";

/** One help-line sentence for every `--actor` flag; the forms text itself lives in core. */
export const ACTOR_FORMS_HELP = `On an OKF v0.2 bundle the value must be an OKF actor: ${OKF_ACTOR_FORMS}.`;

/**
 * The legacy environment variable, spelled here rather than imported: `env-policy.ts` imports
 * `errors.ts`, which imports this module. A test pins the literal to the exported constant.
 */
const LEGACY_ACTOR_VARIABLE = "AGENTSTATE_LITE_ACTOR";

/**
 * The clause that keeps an env repair from leaving a conflicting legacy value behind (the resolver
 * refuses two different values, so the next write would fail for a new reason). A real command
 * separator: prose ("and unset X") pasted into a shell is one export statement that silently
 * exports the words as variables. Shared by the refusal help and the orientation hint.
 */
function legacyEnvCleanup(env: NodeJS.ProcessEnv): string {
  return env[LEGACY_ACTOR_VARIABLE] === undefined ? "" : `; unset ${LEGACY_ACTOR_VARIABLE}`;
}

/** A refusal that says what to type instead of what was rejected, plus the once-only env fix. */
export function actorRefusal(
  actor: string,
  options: { preferHuman?: boolean; env?: NodeJS.ProcessEnv } = {},
): { message: string; help: string } {
  const legacyCleanup = legacyEnvCleanup(options.env ?? process.env);
  const suggestion = suggestOkfActor(actor);
  let options_ = [suggestion.primary, ...suggestion.alternatives];
  if (options.preferHuman) {
    // A verifier surface: the human reading matters most because trust tiers key off `human:`.
    const human = options_.find((candidate) => candidate.startsWith("human:"));
    if (human) options_ = [human, ...options_.filter((candidate) => candidate !== human)];
  }
  const spelled = options_.length > 1
    ? `${options_.slice(0, -1).join(", ")} or ${options_[options_.length - 1]}`
    : options_[0]!;
  const message =
    `actor '${actor}' is not an OKF actor, so this v0.2 bundle refuses to record it as provenance. `
    + `Use ${spelled} — ${OKF_ACTOR_FORMS}.`;
  if (suggestion.placeholder) {
    // Nothing usable could be derived: show the forms, never a pasteable placeholder identity.
    return {
      message,
      help: `rerun with --actor ${commandLiteral("<actor>")} in one of those forms, or set it once: export SUPERBEE_ACTOR=${commandLiteral("<actor>")}${legacyCleanup}`,
    };
  }
  const fix = options_[0]!;
  return {
    message,
    help: `rerun with --actor ${commandToken(fix)}, or set it once: export SUPERBEE_ACTOR=${commandToken(fix)}${legacyCleanup}`,
  };
}

/**
 * How the ambient actor resolved for orientation: a value, nothing, or an environment the resolver
 * itself refused (a blank variable, or two variables that disagree) — carried as the resolver's own
 * diagnostic so orientation never guesses which variable is at fault.
 */
export type ResolvedActorState =
  | { kind: "value"; actor: string }
  | { kind: "unset" }
  | { kind: "unusable"; diagnostic: string };

/** Orientation line for `home`/`session-start`: how the resolved actor will fare on a v0.2 bundle. */
export function describeResolvedActor(
  state: ResolvedActorState,
  options: { env?: NodeJS.ProcessEnv } = {},
): { actor: string; actor_help?: string } {
  const legacyCleanup = legacyEnvCleanup(options.env ?? process.env);
  if (state.kind === "unset") {
    return {
      actor: "unset (writes record process:superbee)",
      actor_help: `set your identity once so writes carry it (${OKF_ACTOR_FORMS}): export SUPERBEE_ACTOR=${commandLiteral("<actor>")}`,
    };
  }
  if (state.kind === "unusable") {
    return {
      actor: "unusable environment value (writes will be refused)",
      actor_help: `${state.diagnostic} — ${OKF_ACTOR_FORMS}`,
    };
  }
  const actor = state.actor;
  if (isOkfActor(actor)) return { actor };
  const { primary, alternatives, placeholder } = suggestOkfActor(actor);
  const spelled = [primary, ...alternatives].join(" or ");
  return {
    actor,
    actor_help: placeholder
      // The pasteable span ends the line: trailing prose would break a whole-line paste.
      ? `'${actor}' is not an OKF actor; writes to this v0.2 bundle will be refused — set a real one (${OKF_ACTOR_FORMS}): export SUPERBEE_ACTOR=${commandLiteral("<actor>")}${legacyCleanup}`
      : `'${actor}' is not an OKF actor; writes to this v0.2 bundle will be refused — use ${spelled}: export SUPERBEE_ACTOR=${commandToken(primary)}${legacyCleanup}`,
  };
}
