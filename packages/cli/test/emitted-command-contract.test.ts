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
import { renderPosixToken } from "../src/shell-quoting.js";
import { cliInvocation } from "../src/invocation.js";
import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";
import { CliError } from "../src/errors.js";
import {
  CONTRACT_VALUES, makeHarness, shells,
} from "./support/command-contract.js";

const SHELLS = shells();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (a) RENDERS — pure coverage for the supported first-party POSIX renderer.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("(a) RENDERS: every value yields a token on supported first-party hosts", () => {
  for (const { id, value, because } of CONTRACT_VALUES) {
    const rendered = commandToken(value);
    assert.equal(typeof rendered, "string", `${id} (${because})`);
    assert.ok(rendered.length > 0, `${id}: a renderable value must produce a token`);
  }
});

test("(a) RENDERS: POSIX is total — it never refuses a value", () => {
  for (const { id, value } of CONTRACT_VALUES) {
    assert.equal(typeof renderPosixToken(value), "string", id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (b) PARSES and (c) DELIVERS — require the supported POSIX shell contract. A reader pastes the
// emitted command into the shell selected by the first-party host adapter.
// ─────────────────────────────────────────────────────────────────────────────────────────────

for (const shell of SHELLS.filter((candidate) => candidate.id === "sh")) {
  const gate = { skip: shell.available ? false : `${shell.unavailableReason} — the contract is NOT verified for this shell here` };

  test(`(b+c) ${shell.id}: every rendered value PARSES and is DELIVERED inertly and verbatim`, gate, () => {
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
        assert.ok(
          !delivered.includes("EXPANDED"),
          `${shell.id}/${id}: the shell EXPANDED something: ${JSON.stringify(delivered)}`,
        );

        // (c2) DELIVERED-VERBATIM — the bytes that arrive are the bytes we rendered.
        assert.equal(
          delivered,
          value,
          `${shell.id}/${id}: value not delivered verbatim (${because})\n`
            + `  expected=${JSON.stringify(value)}\n  actual=${JSON.stringify(delivered)}\n  token=${rendered}`,
        );
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

for (const shell of SHELLS.filter((candidate) => candidate.id === "sh")) {
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
// NON-NATIVE PAIRING — the limit of the contract, asserted rather than assumed.
//
// The first-party renderer emits POSIX quoting, but the thing that parses an emitted command is the
// user's SHELL, and shells available on a supported host do not all agree. It emits `'…'`, escaping an
// embedded quote as `'\''`; sh understands that, PowerShell does not — it escapes a quote by
// DOUBLING it and treats `\` literally. PowerShell runs on POSIX hosts, so "the user's shell is
// pwsh on Linux or macOS" is a real configuration the renderer does not currently target.
//
// This is pinned in BOTH directions so the scope is a measured statement rather than a claim:
// values without an embedded quote ARE delivered inertly through pwsh, and a value WITH one is
// not. Narrowing the matrix without this cell would hide a real gap behind a green suite.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const posixRendered = SHELLS.find((candidate) => candidate.id === "pwsh");
const nonNativeGate = {
  skip: posixRendered?.available
    ? false
    : "POSIX-rendered/pwsh pairing not exercised here (no pwsh or powershell)",
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
