/**
 * Adversarial coverage for the emitted-command quoting authority (src/command-text.ts).
 *
 * The CLI prints follow-up commands a human or agent is expected to RUN, built from values it does
 * not own: a kind convention's `governs`, declared field names, enum values and link types are
 * written by whoever authored the bundle; `.agentstate.json`'s binding by whoever authored the
 * repository. Each test drives one of those surfaces with a value carrying every shell
 * metacharacter that matters and asserts the value comes back as ONE inert argument.
 *
 * A string comparison alone would be circular — it checks the rendering we chose, not that the
 * rendering is safe. So every assertion EXECUTES the emitted command under `/bin/sh`, with the CLI
 * invocation prefix swapped for a script that dumps its argv. That gives three facts at once:
 *   • no marker file appears, so nothing in the payload executed (each marker is made by a shell
 *     REDIRECTION, which needs no PATH and therefore fires even with PATH emptied);
 *   • `sh` reports no error, so the command is syntactically VALID — without this a regression that
 *     emitted an unbalanced quote would abort the shell and look like a pass;
 *   • the payload arrives as an ARGUMENT, so it reached the program rather than the shell.
 *
 * `the injection probe itself detects …` is the control: it feeds the same harness a bare and a
 * double-quoted interpolation, neither of which the authority emits. If it ever stops tripping
 * markers, every other assertion here is worthless.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, CONVENTION_TYPE } from "@superbee/core";

import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";
import { resolveProjectBinding } from "../src/bundle.js";
import { cliInvocation } from "../src/invocation.js";
import { commandToken } from "../src/command-text.js";
import { CliError } from "../src/errors.js";

/**
 * This probe drives `/bin/sh` directly. On Windows it would not merely be inapplicable, it would be
 * MISLEADING: `spawnSync("/bin/sh")` fails, so stderr is empty and the validity assertion passes
 * vacuously while the argv assertion fails for the wrong reason. `windows-support-probe.yml` runs
 * the per-workspace suites, so leaving it unguarded would report a Windows regression that is not
 * one. Windows rendering is covered by `command-text.test.ts`, which parameterises the platform.
 */
const posixOnly = { skip: process.platform === "win32" ? "POSIX shell probe; see command-text.test.ts" : false };

const T = "2026-07-01T00:00:00.000Z";
const BODY = "# Summary\n\nx\n";

/** Files a successful injection creates. Each is made by a REDIRECTION — no PATH lookup needed. */
const MARKERS = ["MARKER_BARE_SEPARATOR", "MARKER_QUOTED_SEPARATOR", "MARKER_SUBSTITUTION", "MARKER_BACKTICK"] as const;
const [BARE_SEPARATOR, QUOTED_SEPARATOR, SUBSTITUTION, BACKTICK] = MARKERS;

/**
 * The value every test feeds the CLI. Both quote characters appear in BALANCED pairs so that each
 * regression shape stays syntactically valid and is caught by an actual EXECUTION rather than by
 * `sh` giving up — an unbalanced payload aborts the shell, which is a pass that proves nothing.
 * The two separators are placed so that one fires per shape:
 *   • emitted bare    -> the first `;` sits outside any quoting: BARE_SEPARATOR, plus SUBSTITUTION
 *                        and BACKTICK;
 *   • emitted in "…"  -> the payload's own `"` CLOSES the emitter's quoting, so the second `;` is
 *                        outside it: QUOTED_SEPARATOR, plus SUBSTITUTION and BACKTICK, which never
 *                        needed to escape quoting at all;
 *   • emitted through the quoting authority -> one inert argument, no markers.
 */
const PAYLOAD =
  `p'q'r; > ${BARE_SEPARATOR}; "; > ${QUOTED_SEPARATOR}; "t$(> ${SUBSTITUTION}) \`> ${BACKTICK}\` :`;

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

interface EmittedRun {
  argv: string[];
  stderr: string;
  markers: string[];
}

/**
 * Execute one emitted command with its CLI invocation prefix replaced by an argv-dumping script.
 * PATH is emptied so nothing else can resolve; the script is reached by absolute path.
 */
async function executeEmitted(command: string): Promise<EmittedRun> {
  const home = await tempDir("superbee-emit-");
  try {
    const script = path.join(home, "dump");
    const argvOut = path.join(home, "argv");
    const cwd = path.join(home, "run");
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvOut}"\n`, "utf8");
    await chmod(script, 0o755);
    await writeFile(path.join(home, ".keep"), "", "utf8");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cwd);

    const prefix = cliInvocation();
    assert.ok(command.startsWith(prefix), `emitted command should start with the CLI prefix: ${command}`);
    const rewritten = script + command.slice(prefix.length);

    const result = spawnSync("/bin/sh", ["-c", rewritten], {
      cwd,
      env: { PATH: "", HOME: cwd },
      encoding: "utf8",
      timeout: 30_000,
    });
    const argv = existsSync(argvOut)
      ? readFileSync(argvOut, "utf8").split("\n").slice(0, -1)
      : [];
    return {
      argv,
      stderr: result.stderr ?? "",
      markers: MARKERS.filter((marker) => existsSync(path.join(cwd, marker))),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * CLI-OWNED `<…>` scaffolding the reader is told to replace before running. It is left unquoted on
 * purpose (the brackets are the instruction), so `sh` would read a bare `<command>` as a redirect —
 * fill it first, exactly as the reader would. Only UNQUOTED placeholders are filled: a bracketed
 * token that came back inside quotes is a rendered VALUE, and rewriting it would hide the thing
 * under test.
 */
function fillPlaceholders(command: string): string {
  // Scan with the QUOTING STATE, not a one-byte lookbehind: inside `'tasks/<task>'` the byte before
  // `<` is `/`, so a lookbehind would rewrite a rendered VALUE — silently neutralising a payload of
  // that shape, and masking the omitted-value placeholder if a Windows case is ever added here.
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const character = command[i]!;
    if (quote) {
      out += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      out += character;
      continue;
    }
    if (character === "<") {
      const end = command.indexOf(">", i);
      const inner = end === -1 ? undefined : command.slice(i + 1, end);
      if (inner !== undefined && /^[A-Za-z][A-Za-z0-9 _|./-]*$/.test(inner)) {
        out += "PLACEHOLDER";
        i = end;
        continue;
      }
    }
    out += character;
  }
  return out;
}

/** The emitted command must run inertly and deliver the payload as an argument, not as shell code. */
async function assertInert(command: string, label: string): Promise<void> {
  const run = await executeEmitted(fillPlaceholders(command));
  assert.deepEqual(run.markers, [], `${label}: emitted command EXECUTED injected input:\n${command}`);
  assert.equal(run.stderr, "", `${label}: emitted command is not valid shell:\n${command}`);
  assert.ok(
    run.argv.some((argument) => argument.includes(BARE_SEPARATOR)),
    `${label}: the payload never reached argv (argv=${JSON.stringify(run.argv)}) for:\n${command}`,
  );
}

/** Run the raw text under the same harness, without the prefix rewrite — used only by the control. */
function markersFromRaw(command: string, cwd: string): string[] {
  spawnSync("/bin/sh", ["-c", command], { cwd, env: { PATH: "", HOME: cwd }, encoding: "utf8", timeout: 30_000 });
  return MARKERS.filter((marker) => existsSync(path.join(cwd, marker)));
}

async function rejection(run: () => Promise<void>): Promise<CliError> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof CliError, `expected a CliError, got ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: "expected the command to fail" });
}

async function runJson(
  cmd: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>,
  argv: string[],
): Promise<Record<string, unknown>> {
  let out = "";
  await cmd([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

test("the injection probe itself detects an unquoted and a double-quoted interpolation", posixOnly, async () => {
  const bare = await tempDir("superbee-control-bare-");
  const quoted = await tempDir("superbee-control-dq-");
  try {
    assert.deepEqual(
      markersFromRaw(`superbee doc write x --type value${PAYLOAD}`, bare).sort(),
      [BARE_SEPARATOR, SUBSTITUTION, BACKTICK].sort(),
      "an UNQUOTED interpolation must execute the payload, or this probe proves nothing",
    );
    assert.deepEqual(
      markersFromRaw(`superbee doc write x --type "value${PAYLOAD}"`, quoted).sort(),
      [QUOTED_SEPARATOR, SUBSTITUTION, BACKTICK].sort(),
      "DOUBLE QUOTES must not contain it either — substitution stays live and a literal quote ends the quoting",
    );
  } finally {
    await rm(bare, { recursive: true, force: true });
    await rm(quoted, { recursive: true, force: true });
  }
});

test("a completing `doc update` command renders a hostile field name and enum value as single arguments", posixOnly, async () => {
  const dir = await tempDir("superbee-inject-kind-");
  try {
    const bundle = { root: dir };
    await initBundle(dir, { okfVersion: "0.1" });
    await writeDoc(bundle, {
      id: "conventions/hostile",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Hostile",
        path: "hostile/",
        title: "Hostile",
        timestamp: T,
        fields: { required: [PAYLOAD], optional: ["title"], values: { [PAYLOAD]: [PAYLOAD] } },
      },
      body: BODY,
    });
    await writeDoc(bundle, {
      id: "hostile/one",
      frontmatter: { type: "Hostile", title: "One", timestamp: T },
      body: BODY,
    });

    // `doc write --strict` over an EXISTING doc is the surface whose help is documented as a
    // literal, ready-to-run `doc update` argv — the one a consumer is most likely to paste unedited.
    const err = await rejection(() =>
      doc(
        ["write", "hostile/one", "--type", "Hostile", "--title", "Two", "--body", BODY, "--strict", "--dir", dir, "--json"],
        { stdout: () => {} },
      ),
    );
    assert.ok(err.help, "the strict refusal must carry a completing command");
    await assertInert(err.help, "completing doc update (field name + enum placeholder)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`new` success-path link hints render a hostile kind name, id prefix and link type as single arguments", posixOnly, async () => {
  const dir = await tempDir("superbee-inject-links-");
  try {
    const bundle = { root: dir };
    await initBundle(dir, { okfVersion: "0.1" });
    await writeDoc(bundle, {
      id: "conventions/hostile",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: PAYLOAD,
        path: "hostile/",
        title: "Hostile",
        timestamp: T,
        fields: { required: [], optional: ["title"] },
        links: { [PAYLOAD]: PAYLOAD },
      },
      body: BODY,
    });

    const receipt = await runJson(newCommand, [PAYLOAD, "one", "--title", "One", "--dir", dir]);
    const help = receipt.help as string[];
    assert.ok(Array.isArray(help), `expected receipt help, got ${JSON.stringify(receipt.help)}`);
    const hints = help.filter((entry) => entry.includes(BARE_SEPARATOR));
    assert.ok(hints.length > 0, `expected at least one link hint carrying the payload: ${JSON.stringify(help)}`);
    for (const [index, hint] of hints.entries()) {
      // The hint is prefixed with English ("link to a <Kind>: "); the command starts at the prefix.
      await assertInert(hint.slice(hint.indexOf(cliInvocation())), `link hint ${index}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`new`'s ALREADY_EXISTS remedy renders a hostile kind name as a single argument", posixOnly, async () => {
  const dir = await tempDir("superbee-inject-exists-");
  try {
    const bundle = { root: dir };
    await initBundle(dir, { okfVersion: "0.1" });
    await writeDoc(bundle, {
      id: "conventions/hostile",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: PAYLOAD,
        path: "hostile/",
        title: "Hostile",
        timestamp: T,
        fields: { required: [], optional: ["title"] },
      },
      body: BODY,
    });
    await runJson(newCommand, [PAYLOAD, "one", "--title", "One", "--dir", dir]);

    const err = await rejection(() =>
      newCommand([PAYLOAD, "one", "--title", "Two", "--dir", dir, "--json"], { stdout: () => {} }),
    );
    assert.equal(err.code, "ALREADY_EXISTS");
    // The `--type` remedy is embedded in the MESSAGE, delimited by prose quotes.
    const start = err.message.indexOf(`${cliInvocation()} doc write`);
    const end = err.message.indexOf("' to overwrite", start);
    assert.ok(start !== -1 && end > start, `expected an overwrite remedy, got: ${err.message}`);
    await assertInert(err.message.slice(start, end), "ALREADY_EXISTS overwrite remedy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a repo-authored project binding renders its URL as a single argument in the emitted --remote help", posixOnly, async () => {
  const dir = await tempDir("superbee-inject-binding-");
  try {
    // `.agentstate.json` is committed by whoever wrote the repository, not typed by the operator.
    // `bindingUriIntent` echoes the RAW value, not `URL.href`, so everything the WHATWG parser
    // tolerates survives verbatim into the emitted `--remote` argument.
    const hostileUrl = `http://example.com/a${PAYLOAD}`;
    await writeFile(path.join(dir, ".agentstate.json"), JSON.stringify({ bundle: hostileUrl }), "utf8");
    const err = await rejection(async () => {
      await resolveProjectBinding(dir);
    });
    assert.ok(err.help, "a URL binding must fail closed with a --remote help");
    await assertInert(err.help, "project binding --remote help");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// PowerShell inertness.
//
// The Windows refusal class in shell-quoting.ts rests on a claim about a DIFFERENT tokenizer than
// any test above exercises: PowerShell's `CharTraits.IsDoubleQuote` accepts typographic quotes, and
// `ScanStringLiteral` closes a double-quoted string at the first character satisfying it without
// requiring the closing character to match the opening one. Running the CLI's own suite on a
// Windows runner does not check that — it exercises the RENDERER and would go green whether or not
// the claim holds. Only executing an emitted command through PowerShell settles it.
//
// So the verification is a test rather than a note. It runs wherever `pwsh` (or Windows PowerShell)
// exists, and SKIPS with a stated reason where it does not, so a reader can always tell "verified
// here" from "not run here" — never a vacuous pass, which is the failure mode this file already
// had to be fixed for once.
function findPowerShell(): string | undefined {
  for (const candidate of ["pwsh", "powershell"]) {
    try {
      execFileSync(candidate, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", timeout: 30_000 });
      return candidate;
    } catch {
      // not installed, or not this name on this host
    }
  }
  return undefined;
}

const POWERSHELL = findPowerShell();
const powershellOnly = {
  skip: POWERSHELL
    ? false
    : "no pwsh/powershell on this host — the PowerShell tokenizer claim behind the Windows refusal class is NOT verified here",
};

/** A marker written by a PowerShell cmdlet, so it needs no PATH lookup and no external binary. */
const PWSH_MARKER = "MARKER_POWERSHELL";
const PWSH_BREAKOUT = `Set-Content -LiteralPath ${PWSH_MARKER} -Value x`;

interface PowerShellRun {
  argv: string[];
  markerCreated: boolean;
  stderr: string;
}

/**
 * Execute one emitted command under PowerShell with the CLI prefix replaced by an argv-dumping
 * script, mirroring {@link executeEmitted}. `$args` is written verbatim, so a value that arrived as
 * ONE argument is visible as one line.
 */
async function executeUnderPowerShell(command: string): Promise<PowerShellRun> {
  const home = await tempDir("superbee-pwsh-");
  try {
    const script = path.join(home, "dump.ps1");
    const argvOut = path.join(home, "argv.txt");
    const cwd = path.join(home, "run");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cwd);
    await writeFile(script, `Set-Content -LiteralPath '${argvOut}' -Value $args\n`, "utf8");

    const prefix = cliInvocation();
    assert.ok(command.startsWith(prefix), `emitted command should start with the CLI prefix: ${command}`);
    const rewritten = `& '${script}' ${command.slice(prefix.length)}`;

    const result = spawnSync(POWERSHELL!, ["-NoProfile", "-NonInteractive", "-Command", rewritten], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
    });
    const argv = existsSync(argvOut)
      ? readFileSync(argvOut, "utf8").split(/\r?\n/).filter((line) => line !== "")
      : [];
    return { argv, markerCreated: existsSync(path.join(cwd, PWSH_MARKER)), stderr: result.stderr ?? "" };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Render `value` the way a Windows host would, whatever host is actually running the test. */
function renderAsWindows(value: string): string {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  try {
    return `${cliInvocation()} doc write x --type ${commandToken(value)}`;
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/**
 * The premise, tested rather than asserted. If PowerShell does NOT close a double-quoted string at
 * U+201D, this fails — and that failure means the refusal class in shell-quoting.ts is broader than
 * it needs to be, NOT that anything is exposed. Read a red here as "revisit the breadth", never as
 * "vulnerable".
 */
test("PowerShell closes a double-quoted string at a typographic quote (the premise for refusing them)", powershellOnly, async () => {
  // Deliberately NOT rendered: this is the shape the refusal class exists to prevent ever emitting.
  const unrefused = `${cliInvocation()} doc write x --type "a”; ${PWSH_BREAKOUT}; “b"`;
  const run = await executeUnderPowerShell(unrefused);
  assert.equal(
    run.markerCreated,
    true,
    "PowerShell did not treat U+201D as closing the string. The premise behind refusing the "
      + "smart-quote family in shell-quoting.ts does not hold on this host — the refusal is then "
      + "merely over-broad, not wrong.\n"
      // argv separates the two ways this can go red. A TOKENIZER finding still runs the script, so
      // argv is populated; a BROKEN HARNESS (a host where PowerShell never really executed) leaves
      // it empty. Without this, an unresponsive host sends a maintainer to read tokenizer source.
      + `argv=${JSON.stringify(run.argv)} — if this is EMPTY, PowerShell did not run at all and this `
      + "is a harness problem, not a finding about the tokenizer.\n"
      + `stderr=${run.stderr}`,
  );
});

/**
 * The property that matters: whatever the renderer emits must be inert under PowerShell. Covers a
 * typographic quote, a plain U+0022, and a value that IS rendered rather than refused — so this
 * documents the actual behavior whichever way the U+0022 refuse-vs-escape question is settled.
 */
test("a command emitted through the Windows renderer is inert under PowerShell", powershellOnly, async () => {
  const cases: [string, string][] = [
    ["typographic quote", `a”; ${PWSH_BREAKOUT}; “b`],
    ["plain double quote", `a"; ${PWSH_BREAKOUT}; "b`],
    ["subexpression", `a$(${PWSH_BREAKOUT})b`],
    ["ordinary multi-word value", "Context Note"],
  ];
  for (const [label, value] of cases) {
    const command = renderAsWindows(value);
    const run = await executeUnderPowerShell(command);
    assert.equal(run.markerCreated, false, `${label}: emitted command EXECUTED injected input:\n${command}`);
    // Targeted rather than "stderr is empty": a PARSE error is the vacuous-pass risk, and demanding
    // silence would make this brittle against any host-specific notice. The argv assertion below is
    // the real guard — a command PowerShell failed to parse delivers no arguments at all.
    assert.ok(
      !/ParserError|Unexpected token|Missing|TerminatorExpected/i.test(run.stderr),
      `${label}: emitted command is not valid PowerShell:\n${command}\n${run.stderr}`,
    );
    // Whatever survived rendering must arrive as ONE argument. A refused value arrives as the
    // placeholder; a rendered one arrives verbatim. Both are single arguments, and asserting that
    // rather than a fixed string keeps this honest if the refusal set is later narrowed.
    const delivered = run.argv[run.argv.length - 1];
    assert.ok(
      delivered === value || delivered === "<value-omitted-unquotable>",
      `${label}: expected the value or the placeholder as ONE argument, got ${JSON.stringify(run.argv)}`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// cmd.exe inertness.
//
// The Windows renderer emits `"…"`, and cmd.exe expands a matched `%NAME%` pair INSIDE double
// quotes. Refusing `%` is what keeps a rendered token inert there — but that is a claim about
// cmd.exe, and nothing above tests cmd.exe. Running the suite on a Windows runner exercises the
// RENDERER and would stay green whether or not the claim holds, exactly as it would have for the
// PowerShell claim. So the verification is a probe, gated on a real cmd.exe and skipping visibly
// where there is none.
const COMSPEC = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : undefined;
const cmdOnly = {
  skip: COMSPEC
    ? false
    : "no cmd.exe on this host — the percent-expansion claim behind the Windows refusal of `%` is NOT verified here",
};

/** A value planted in the environment; if cmd.exe expands, it appears in the child's argv. */
const SECRET_VAR = "SUPERBEE_PROBE_SECRET";
const SECRET_VALUE = "PROBE_SECRET_LEAKED";

interface CmdRun {
  argv: string[];
  stderr: string;
}

/**
 * Set up the cmd.exe harness ONCE and hand back a runner. The dumper and its temp tree are built
 * per TEST rather than per case: Windows spawns are the expensive part and the lane that runs these
 * has a wall-clock budget, so there is no reason to rebuild the scaffolding four times.
 */
async function withCmdHarness(
  body: (run: (command: string) => CmdRun) => Promise<void>,
): Promise<void> {
  const home = await tempDir("superbee-cmd-");
  try {
    const dump = path.join(home, "dump.cjs");
    const cwd = path.join(home, "run");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cwd);

    let call = 0;
    const run = (command: string): CmdRun => {
      const argvOut = path.join(home, `argv-${(call += 1)}.txt`);
      writeFileSync(
        dump,
        `require("node:fs").writeFileSync(process.env.SUPERBEE_ARGV_OUT, process.argv.slice(2).join("\\n"));\n`,
        "utf8",
      );
      const prefix = cliInvocation();
      assert.ok(command.startsWith(prefix), `emitted command should start with the CLI prefix: ${command}`);
      const rewritten = `"${process.execPath}" "${dump}" ${command.slice(prefix.length)}`;

      // Two cmd.exe rules have to be satisfied for the dumper to launch at all, and getting either
      // wrong looks like "the premise is false" rather than "the harness is broken":
      //
      //  1. Under `/s`, cmd strips the FIRST and LAST quote of the command line (`cmd /?`, rule 2).
      //     Ours both begins with a quoted node path and ends with a quoted argument, so without an
      //     extra outer pair the stripping lands inside the real command and nothing runs. This is
      //     not hypothetical: it is exactly how the first version of this probe failed on a real
      //     Windows runner, reporting `argv=[]` and "is not recognized as an internal or external
      //     command".
      //  2. Node would otherwise apply Windows argument escaping (`\"`), which cmd does not
      //     understand, so the command line is passed verbatim instead.
      const result = spawnSync(COMSPEC!, ["/d", "/s", "/c", `"${rewritten}"`], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, [SECRET_VAR]: SECRET_VALUE, SUPERBEE_ARGV_OUT: argvOut },
        windowsVerbatimArguments: true,
        timeout: 60_000,
      });
      const argv = existsSync(argvOut)
        ? readFileSync(argvOut, "utf8").split("\n").filter((line) => line !== "")
        : [];
      return { argv, stderr: result.stderr ?? "" };
    };
    await body(run);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * The premise, tested rather than asserted: cmd.exe DOES expand `%NAME%` inside double quotes. If
 * this fails, refusing `%` is merely over-broad rather than wrong — read a red here as "revisit the
 * breadth", never as "vulnerable". An EMPTY argv means cmd.exe never ran the dumper at all, which
 * is a harness problem and not a finding.
 */
test("cmd.exe expands %NAME% inside double quotes (the premise for refusing the percent sign)", cmdOnly, async () => {
  await withCmdHarness(async (run) => {
  const observed = run(`${cliInvocation()} doc write x --type "%${SECRET_VAR}%"`);
  assert.ok(
    observed.argv.some((argument) => argument.includes(SECRET_VALUE)),
    "cmd.exe did not expand %NAME% inside double quotes. The premise behind refusing `%` in "
      + "shell-quoting.ts does not hold on this host — the refusal is then merely over-broad, not "
      + `wrong.\nargv=${JSON.stringify(observed.argv)} — if this is EMPTY, cmd.exe did not run the `
      + `dumper at all and this is a harness problem, not a finding.\nstderr=${observed.stderr}`,
  );
  });
});

/** The property that matters: nothing the renderer emits can be expanded by cmd.exe. */
test("a command emitted through the Windows renderer performs no expansion under cmd.exe", cmdOnly, async () => {
  const cases: [string, string][] = [
    ["environment reference", `%${SECRET_VAR}%`],
    ["percent-encoded URL", "http://example.com/a%20b"],
    ["ordinary multi-word value", "Context Note"],
    ["apostrophe", "Owner's Guide"],
  ];
  await withCmdHarness(async (run) => {
    for (const [label, value] of cases) {
      const command = renderAsWindows(value);
      const observed = run(command);
      assert.ok(
        !observed.argv.some((argument) => argument.includes(SECRET_VALUE)),
        `${label}: cmd.exe EXPANDED an environment value into the emitted command:\n${command}\n`
          + `argv=${JSON.stringify(observed.argv)}`,
      );
      // Exactly one argument, whether the value survived rendering or was withheld.
      const delivered = observed.argv[observed.argv.length - 1];
      assert.ok(
        delivered === value || delivered === "<value-omitted-unquotable>",
        `${label}: expected the value or the placeholder as ONE argument, got ${JSON.stringify(observed.argv)}`,
      );
    }
  });
});
