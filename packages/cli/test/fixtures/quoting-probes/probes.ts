// Deliberately UNSAFE command-rendering shapes, kept out of `src` so the real scan stays clean.
// `emitted-command-quoting.test.ts` scans this directory and asserts every shape below is caught.
// Each probe is a defeat attempt that the scanner previously missed, or a control that pins a rule
// still fires. Nothing here is imported by the CLI.
import { commandLiteral as lit, commandLiteral, commandToken, type CommandText, type CommandText as CT } from "../../../src/command-text.js";
import { cliInvocation, shellArg } from "../../../src/invocation.js";
import * as ct from "../../../src/command-text.js";
import { commandToken as foreignToken, commandLiteral as foreignLiteral } from "./foreign-authority.js";

type LocalAlias = CT;

/** An import alias used to hide `commandLiteral`'s literal-only requirement. */
export function aliasedCommandLiteral(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${lit(bundleValue)}`;
}

/** A command built with `+`, so it is never a template expression. */
export function concatenatedCommand(bundleValue: string): string {
  return cliInvocation() + " doc write x --type " + bundleValue;
}

/** A command built by joining an array. */
export function joinedCommand(bundleValue: string): string {
  return [cliInvocation(), "doc", "write", "x", "--type", bundleValue].join(" ");
}

/** A brand cast — the one expression that mints command text from a raw string. */
export function castValue(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${bundleValue as unknown as CommandText}`;
}

/** Re-wrapping an already-rendered token in the sentence's own quotes. */
export function doubleWrapped(bundleValue: string): string {
  return `did you mean --text '${commandToken(bundleValue)}'?`;
}

/** Control: the bare interpolation the whole rule exists to catch. */
export function bareInterpolation(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${bundleValue}`;
}

/** Control: the double-quote idiom that reads as quoting and is not. */
export function doubleQuotedIdiom(bundleValue: string): string {
  return `${cliInvocation()} kind field "${bundleValue}" add name`;
}

/** Control: a correctly rendered command, which must NOT be reported. */
export function rendered(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${commandToken(bundleValue)}`;
}

/** Binding the producer to a local const, so the callee symbol is the VARIABLE. */
const boundLiteral = commandLiteral;
export function localConstBinding(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${boundLiteral(bundleValue)}`;
}

/** A type alias, so the cast's type is not spelled `CommandText`. */
export function aliasedCast(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${bundleValue as unknown as CT}`;
}

/** The re-wrap shape with one quote moved across a `+`. */
export function reWrapAcrossConcat(bundleValue: string): string {
  return `no links matched --text '` + commandToken(bundleValue) + `'`;
}

/** A namespace-qualified cast — the ORDINARY spelling after `import * as ct`. */
export function namespaceQualifiedCast(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${bundleValue as unknown as ct.CommandText}`;
}

/** A locally re-aliased type, so the cast names neither export. */
export function localAliasCast(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${bundleValue as unknown as LocalAlias}`;
}

/**
 * A FOREIGN function sharing the authority's renderer name must not inherit the whole-argument
 * exemption: the inner `--type ${b}` is a real unrendered value and has to be reported.
 */
export function foreignRendererExemption(bundleValue: string): string {
  return `${cliInvocation()} ${foreignToken(`doc write x --type ${bundleValue}`)}`;
}

/**
 * Control for the other direction: a foreign function merely NAMED `commandLiteral` must NOT be
 * held to the authority's literal-only contract. This line must produce no violation.
 */
export function foreignLiteralIsNotTheAuthority(bundleValue: string): string {
  return `a tidied value: ${foreignLiteral(bundleValue)}`;
}

/** `shellArg` throws on Windows instead of degrading; only the authority may call it directly. */
export function directShellArg(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${shellArg(bundleValue)}`;
}
