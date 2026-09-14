/**
 * Mint a `CommandPrefix` for a TEST fixture.
 *
 * Production code obtains one only from `cliInvocation()` / `exactCliInvocation()`, and the quoting
 * checker rejects a brand cast anywhere in `src` outside the authority modules. Tests legitimately
 * need to inject a FIXED prefix so their expectations do not depend on how the running binary was
 * resolved, so the cast lives here, once, rather than being scattered as `as CommandPrefix` across
 * a dozen test files where it would model exactly the idiom the checker exists to discourage.
 */
import type { CommandPrefix, CommandText } from "../../src/command-text.js";

export function testInvocation(value: string): CommandPrefix {
  return value as CommandPrefix;
}

/** Mint an already-rendered command FRAGMENT for a test fixture (e.g. ` --dir '<path>'`). */
export function testFragment(value: string): CommandText {
  return value as CommandText;
}
