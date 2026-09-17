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
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, CONVENTION_TYPE } from "@superbee/core";

import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";
import { resolveProjectBinding } from "../src/bundle.js";
import { cliInvocation } from "../src/invocation.js";
import { CliError } from "../src/errors.js";

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
  // that shape and masking the quoted-value behavior this helper is meant to preserve.
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

test("the injection probe itself detects an unquoted and a double-quoted interpolation", async () => {
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

test("a completing `doc update` command renders a hostile field name and enum value as single arguments", async () => {
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

test("`new` success-path link hints render a hostile kind name, id prefix and link type as single arguments", async () => {
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

test("`new`'s ALREADY_EXISTS remedy renders a hostile kind name as a single argument", async () => {
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

test("a repo-authored project binding renders its URL as a single argument in the emitted --remote help", async () => {
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
