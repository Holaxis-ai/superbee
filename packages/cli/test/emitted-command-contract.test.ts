/**
 * The emitted-command CONTRACT — see test/support/command-contract.ts for the one-sentence statement.
 *
 * This is the specification the quoting authority is supposed to satisfy. It is deliberately written
 * against BEHAVIOUR (what a shell does with the emitted command) rather than against the renderer's
 * return value, because every defect this change has chased lived in exactly that gap.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, CONVENTION_TYPE } from "@superbee/core";

import { commandToken } from "../src/command-text.js";
import { renderWindowsToken, renderPosixToken } from "../src/shell-quoting.js";
import { cliInvocation } from "../src/invocation.js";
import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";
import { CliError } from "../src/errors.js";
import {
  CONTRACT_VALUES, PLACEHOLDER, makeHarness, onPlatform, shells,
  type Shell,
} from "./support/command-contract.js";

const SHELLS = shells();

/**
 * Cells where DELIVERED-VERBATIM does not hold, named and reasoned rather than silently excluded.
 * Each entry is asserted: the divergence must still occur, and must differ only in the documented
 * way. Delete an entry when it stops being true — do not let it become a baseline.
 */
const KNOWN_FIDELITY_DIVERGENCES: Record<string, string> = {
  "pwsh/trailing-backslash":
    "A trailing backslash run is DOUBLED so the CRT argument parser does not read it as escaping "
    + "the closing quote — required for cmd.exe, which then delivers the value correctly. PowerShell "
    + "does not apply that rule, so it delivers the doubled run literally and the value arrives with "
    + "one extra backslash. INERT either way: one argument, nothing expanded, nothing executed. "
    + "ACCEPTED rather than fixed, because the alternative is refusing `C:\\dir\\` — an utterly "
    + "ordinary Windows path — the way `%` is refused, and unlike `%` there is no security property "
    + "at stake. Scope of the fidelity loss, which is narrower than it looks but NOT nil: for PATHS "
    + "it is absorbed (`path.win32.resolve` normalises `C:\\a\\\\` to `C:\\a`), but for a value "
    + "used as a KEY or stored as TEXT it is not — a kind named `Task\\` would not match its "
    + "registry entry, and a link text would be stored with the extra character. Those values are "
    + "exotic; paths are not; and a rendering that breaks every quoted Windows path would be worse. "
    + "LIMIT OF THIS TOLERANCE: the follow-up assertion collapses ANY trailing backslash run to one "
    + "before comparing, so it pins that the divergence is confined to the trailing run — it would "
    + "NOT notice the run changing MAGNITUDE (two extra backslashes instead of one). Everything "
    + "else about the value is still compared exactly, and the inert assertions are unaffected.",
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (a) RENDERS — pure, so it runs on every host for BOTH platforms.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("(a) RENDERS: every value yields a token or the documented placeholder, on both platforms", () => {
  for (const { id, value, because } of CONTRACT_VALUES) {
    for (const platform of ["linux", "win32"] as const) {
      const rendered = onPlatform(platform, () => commandToken(value));
      assert.equal(typeof rendered, "string", `${id}/${platform} (${because})`);
      const refused = platform === "win32" && renderWindowsToken(value) === undefined;
      if (refused) {
        assert.ok(
          rendered.includes(PLACEHOLDER),
          `${id}/${platform}: an unrenderable value must degrade to the placeholder, got ${rendered}`,
        );
      } else {
        assert.ok(rendered.length > 0, `${id}/${platform}: a renderable value must produce a token`);
      }
    }
  }
});

test("(a) RENDERS: POSIX is total — it never refuses a value", () => {
  for (const { id, value } of CONTRACT_VALUES) {
    assert.equal(typeof renderPosixToken(value), "string", id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (b) PARSES and (c) DELIVERS — require a real shell. Rendering is for the HOST platform, because
// that is the only pairing that occurs in production: a reader pastes into a shell on their own
// machine. A win32-rendered token executed by /bin/sh is a mismatch that never happens, and
// asserting it would test a scenario we do not ship.
// ─────────────────────────────────────────────────────────────────────────────────────────────

for (const shell of SHELLS.filter((candidate) => candidate.native)) {
  const gate = { skip: shell.available ? false : `${shell.unavailableReason} — the contract is NOT verified for this shell here` };

  test(`(b+c) ${shell.id}: every rendered value PARSES, is DELIVERED inertly, and is verbatim except where documented`, gate, () => {
    const harness = makeHarness();
    try {
      for (const { id, value, because } of CONTRACT_VALUES) {
        const rendered = commandToken(value);
        const run = shell.run(rendered, harness.dump, harness.argvOut);

        // (b) PARSES — the shell accepted the line and actually launched the child.
        assert.notEqual(
          run.argv, undefined,
          `${shell.id}/${id}: emitted command did not PARSE (${because})\n`
            + `  token=${rendered}\n  status=${run.status}\n  stderr=${run.stderr}`,
        );

        // (c1) DELIVERED-INERT — the SECURITY property: exactly one argument, nothing expanded.
        // Split from verbatim delivery because the two fail independently, and only this one is
        // about safety. Conflating them would have forced a choice between weakening a security
        // assertion and refusing an ordinary value.
        assert.equal(
          run.argv!.length, 1,
          `${shell.id}/${id}: expected ONE argument, got ${JSON.stringify(run.argv)}`,
        );
        const delivered = run.argv![0]!;
        const withheld = delivered === PLACEHOLDER;
        assert.ok(
          !delivered.includes("EXPANDED"),
          `${shell.id}/${id}: the shell EXPANDED something: ${JSON.stringify(delivered)}`,
        );

        // (c2) DELIVERED-VERBATIM — a FIDELITY property: the bytes that arrive are the bytes we
        // rendered. Held everywhere except the documented cells below.
        const divergence = KNOWN_FIDELITY_DIVERGENCES[`${shell.id}/${id}`];
        if (divergence === undefined) {
          assert.ok(
            delivered === value || withheld,
            `${shell.id}/${id}: value not delivered verbatim (${because})\n`
              + `  expected=${JSON.stringify(value)}\n  actual=${JSON.stringify(delivered)}\n  token=${rendered}`,
          );
        } else {
          // An accepted divergence is asserted, not exempted. It must still DIFFER (or the entry is
          // stale and should be deleted) and must differ ONLY in the documented way, so a different
          // corruption in the same cell still fails.
          assert.notEqual(
            delivered, value,
            `${shell.id}/${id}: this divergence no longer occurs — delete its entry rather than `
              + `leaving an exemption that hides a future regression.\n  ${divergence}`,
          );
          assert.equal(
            delivered.replace(/\\+$/, "\\"), value.replace(/\\+$/, "\\"),
            `${shell.id}/${id}: differs BEYOND the documented divergence\n  ${divergence}\n`
              + `  expected=${JSON.stringify(value)}\n  actual=${JSON.stringify(delivered)}`,
          );
        }
      }
    } finally {
      harness.cleanup();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (b) on REAL receipts — the highest-value property, and the one nothing asserted before. A
// synthetic token can be correct while a whole emitted command is unrunnable.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Collect emitted commands from real CLI receipts and errors, with hostile bundle-authored input. */
async function realEmittedCommands(): Promise<{ label: string; command: string }[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-contract-receipts-"));
  const hostile = "Task ”$(id) 'x' %SUPERBEE_PROBE_VAR%";
  try {
    const bundle = { root: dir };
    await initBundle(dir, { okfVersion: "0.1" });
    await writeDoc(bundle, {
      id: "conventions/hostile",
      frontmatter: {
        type: CONVENTION_TYPE, governs: hostile, path: "hostile/", title: "H",
        timestamp: "2026-07-01T00:00:00.000Z",
        fields: { required: [], optional: ["title"] }, links: { [hostile]: hostile },
      },
      body: "# Summary\n\nx\n",
    });

    const found: { label: string; command: string }[] = [];
    const prefix = cliInvocation();
    const collect = (label: string, text: string | undefined): void => {
      if (!text) return;
      const start = text.indexOf(prefix);
      if (start === -1) return;
      // One emitted command: from the prefix to a chain/prose boundary.
      const span = text.slice(start).split(/[→\n]/)[0]!.replace(/'\s+to\s.*$/, "").trim();
      found.push({ label, command: span });
    };

    let out = "";
    await newCommand([hostile, "one", "--title", "One", "--dir", dir, "--json"], { stdout: (s) => (out += s) });
    for (const [index, hint] of ((JSON.parse(out) as { help?: string[] }).help ?? []).entries()) {
      collect(`new receipt help[${index}]`, hint);
    }

    try {
      await newCommand([hostile, "one", "--title", "Two", "--dir", dir, "--json"], { stdout: () => {} });
    } catch (err) {
      if (err instanceof CliError) { collect("ALREADY_EXISTS remedy", err.message); collect("ALREADY_EXISTS help", err.help); }
    }
    try {
      await doc(["write", "hostile/one", "--type", hostile, "--title", "T", "--body", "# Summary\n\nx\n", "--strict", "--dir", dir, "--json"], { stdout: () => {} });
    } catch (err) {
      if (err instanceof CliError) collect("strict refusal help", err.help);
    }
    return found;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const shell of SHELLS.filter((candidate) => candidate.native)) {
  const gate = { skip: shell.available ? false : `${shell.unavailableReason} — real-receipt executability is NOT verified for this shell here` };

  test(`(b) ${shell.id}: commands taken from REAL receipts parse and deliver hostile values inertly`, gate, async () => {
    const commands = await realEmittedCommands();
    assert.ok(commands.length > 0, "expected at least one emitted command from a real receipt");
    const harness = makeHarness();
    try {
      for (const { label, command } of commands) {
        const prefix = cliInvocation();
        assert.ok(command.startsWith(prefix), `${label}: expected the CLI prefix, got ${command}`);
        // Swap the CLI prefix for the argv dumper; everything after it is the emitted argv verbatim.
        const run = shell.run(command.slice(prefix.length).trim(), harness.dump, harness.argvOut);
        assert.notEqual(
          run.argv, undefined,
          `${shell.id}/${label}: a REAL emitted command did not PARSE\n  command=${command}\n  stderr=${run.stderr}`,
        );
        assert.ok(
          !run.argv!.some((argument) => argument.includes("EXPANDED")),
          `${shell.id}/${label}: the shell EXPANDED an environment value\n  command=${command}\n  argv=${JSON.stringify(run.argv)}`,
        );
      }
    } finally {
      harness.cleanup();
    }
  });
}


// ─────────────────────────────────────────────────────────────────────────────────────────────
// (b) on the INVOCATION PATH a real consumer uses.
//
// Agents are the primary consumer of the help channel, and an agent on Windows shells out. cmd's
// rule 2 (`cmd /?`) strips the leading quote and the LAST quote of a command line WHEN THE FIRST
// CHARACTER IS A QUOTE — so whether an emitted command survives `cmd /s /c` depends on how it
// begins, not on the quoted values inside it. That distinction decides whether we owe users a
// caveat, so it is pinned here rather than reasoned about.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const cmdShell = SHELLS.find((candidate) => candidate.id === "cmd")!;
const cmdGate = { skip: cmdShell.available ? false : `${cmdShell.unavailableReason} — the cmd invocation path is NOT verified here` };

test("(b) cmd: an emitted command whose first token is UNQUOTED survives `cmd /s /c` with no added wrapper", cmdGate, async () => {
  const commands = await realEmittedCommands();
  const harness = makeHarness();
  try {
    for (const { label, command } of commands) {
      const prefix = cliInvocation();
      // `node "<dump>" …` begins with `n`, exactly as `superbee …` does — the shape every emitted
      // command built from cliInvocation() has. NO outer wrapper is added.
      const line = `node "${harness.dump}" ${command.slice(prefix.length).trim()}`;
      const run = cmdShell.runRaw!(line, harness.argvOut);
      assert.notEqual(
        run.argv, undefined,
        `${label}: a real emitted command must survive an UNWRAPPED cmd /s /c
  line=${line}
  stderr=${run.stderr}`,
      );
    }
  } finally {
    harness.cleanup();
  }
});

test("(b) cmd: the boundary — a command whose first token IS quoted needs the wrapper cmd requires", cmdGate, () => {
  const harness = makeHarness();
  try {
    const quotedFirst = `"${process.execPath}" "${harness.dump}" --type "a b"`;
    const unwrapped = cmdShell.runRaw!(quotedFirst, harness.argvOut);
    // This is a property of cmd.exe, not a defect in what we emit: rule 2 mangles it. Only
    // `exactCliInvocation()` produces this shape, and every realistic caller — Node's `exec` and
    // `spawn({shell:true})`, which add the outer pair themselves, or `spawn(file, argv)`, which
    // uses no shell — is unaffected. Pinned so nobody "fixes" the renderer to drop the quoting a
    // path containing spaces genuinely needs.
    assert.equal(
      unwrapped.argv, undefined,
      `expected rule 2 to mangle a quote-initial line; if this now PARSES, cmd's behaviour changed `
        + `and the note in this test should be revisited. argv=${JSON.stringify(unwrapped.argv)}`,
    );
    const wrapped = cmdShell.runRaw!(`"${quotedFirst}"`, harness.argvOut);
    assert.notEqual(wrapped.argv, undefined, "with the outer pair cmd requires, the same line runs");
  } finally {
    harness.cleanup();
  }
});


// ─────────────────────────────────────────────────────────────────────────────────────────────
// NON-NATIVE PAIRING — the limit of the contract, asserted rather than assumed.
//
// The renderer chooses quoting by PLATFORM, but the thing that parses an emitted command is the
// SHELL, and a platform's shells do not agree. On POSIX the renderer emits `'…'`, escaping an
// embedded quote as `'\''`; sh understands that, PowerShell does not — it escapes a quote by
// DOUBLING it and treats `\` literally. PowerShell runs on POSIX hosts, so "the user's shell is
// pwsh on Linux or macOS" is a real configuration the renderer does not currently target.
//
// This is pinned in BOTH directions so the scope is a measured statement rather than a claim:
// values without an embedded quote ARE delivered inertly through pwsh, and a value WITH one is
// not. Narrowing the matrix without this cell would hide a real gap behind a green suite.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const posixRendered = SHELLS.find((candidate) => candidate.id === "pwsh" && !candidate.native);
const nonNativeGate = {
  skip: posixRendered?.available
    ? false
    : "POSIX-rendered/pwsh pairing not exercised here (no pwsh, or this host is Windows)",
};

test("(scope) POSIX-rendered tokens are inert under pwsh EXCEPT where the value contains a quote", nonNativeGate, () => {
  const harness = makeHarness();
  try {
    // Without an embedded quote, POSIX single-quoting is literal in PowerShell too, so the
    // contract happens to hold — that is why the gap is narrow rather than total.
    for (const { id, value } of CONTRACT_VALUES.filter((entry) => !entry.value.includes("'"))) {
      const run = posixRendered!.run(commandToken(value), harness.dump, harness.argvOut);
      assert.notEqual(run.argv, undefined, `${id}: expected a POSIX-rendered token to parse under pwsh`);
      assert.deepEqual(run.argv, [value], `${id}: expected verbatim delivery under pwsh`);
    }

    // With an embedded quote, `'\''` is not PowerShell's escape, so the token fragments. This
    // assertion exists to keep the limitation VISIBLE and to fail if it ever changes shape —
    // including if it is fixed, at which point this cell should be deleted, not relaxed.
    const withQuote = "Owner's Guide";
    const fragmented = posixRendered!.run(commandToken(withQuote), harness.dump, harness.argvOut);
    assert.notDeepEqual(
      fragmented.argv, [withQuote],
      "a POSIX-rendered token containing a quote is now delivered verbatim under pwsh — the "
        + "limitation this cell documents no longer holds; delete the cell rather than relaxing it.",
    );
  } finally {
    harness.cleanup();
  }
});
