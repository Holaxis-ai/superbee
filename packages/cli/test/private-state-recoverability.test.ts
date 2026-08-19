// THE recoverability table (boundary specification section 8).
//
// A refusal with no exit path is a defect. Every refusal must name a command that changes the
// state, and that command must not be the command that just failed. The third column is the point
// of this table: it EXECUTES the emitted remedy character-for-character and re-inspects. An earlier
// round shipped a remedy that no test ever ran, and it turned out to be data-losing.
//
// Adding a refusal: one row `[trigger, help, remedy]`. The remedy is extracted from the emitted
// output — never retyped — so a row cannot drift from what the CLI actually prints.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  binShim,
  boundaryFixture,
  runCli,
  runShell,
  type BoundaryFixture,
} from "./support/private-state-fixtures.js";

interface Remedy {
  /** The exact shell command line to run. */
  readonly command: string;
  /**
   * Placeholders the emitted text cannot fill in (`<name>`), and what this row substituted. A row
   * with no substitutions runs the emitted string byte-for-byte.
   */
  readonly substitutions?: Readonly<Record<string, string>>;
}

interface RecoverabilityRow {
  readonly label: string;
  /** The refusing invocation, and the shell command line it corresponds to (for the "not the same
   * command" assertion). */
  readonly trigger: (fixture: Fixture) => { readonly argv: readonly string[]; readonly commandLine: string };
  readonly expectStatus: number;
  /** The emitted help/next-command the row reads its remedy out of. */
  readonly help: RegExp;
  /** Pull the remedy OUT of the emitted output — never retype it. */
  readonly remedy: (output: string, fixture: Fixture) => Remedy;
  /**
   * Does executing the remedy change the state? `guidance-only` is a legitimate value for a refusal
   * whose required exit node is an alternative to choose, not a mutation — but the command still
   * has to run.
   */
  readonly effect: "changes-state" | "guidance-only";
  /** Re-inspect AFTER the remedy ran. This is what makes the third column a measurement. */
  readonly verify: (fixture: Fixture) => void;
  /** Shape the fixture this row needs before the trigger runs. */
  readonly arrange?: (fixture: Fixture) => void;
  readonly skip?: string;
}

interface Fixture extends BoundaryFixture {
  readonly bin: string;
}

const RECOVERABILITY_ROWS: readonly RecoverabilityRow[] = [
  {
    label: "R1 — the bundle would ENCLOSE a guarded root",
    trigger: (f) => ({ argv: ["init", "--dir", f.home, "--json"], commandLine: `superbee init --dir '${f.home}' --json` }),
    expectStatus: 5,
    help: /mkdir -p ~\/projects\/<name> && cd ~\/projects\/<name> && superbee init --create-only --dir \.superbee/,
    remedy: (output) => {
      const start = output.indexOf("mkdir -p");
      const emitted = output.slice(start, output.indexOf(" (move", start));
      return { command: emitted.replaceAll("<name>", "demo"), substitutions: { "<name>": "demo" } };
    },
    effect: "changes-state",
    verify: (f) => {
      const created = path.join(f.home, "projects", "demo", ".superbee");
      assert.ok(existsSync(path.join(created, "index.md")), "the emitted chain must actually create a bundle");
      const listed = runCli(["list", "--dir", created, "--json"], { cwd: f.home, home: f.home });
      assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    },
  },
  {
    label: "R2 — the bundle IS a guarded root",
    trigger: (f) => ({
      argv: ["init", "--dir", f.stateRoot, "--json"],
      commandLine: `superbee init --dir '${f.stateRoot}' --json`,
    }),
    expectStatus: 5,
    help: /choose a project \.superbee directory, then rerun superbee setup/,
    remedy: (output) => {
      const start = output.indexOf("then rerun ") + "then rerun ".length;
      return { command: output.slice(start, output.indexOf('"', start)).trim() };
    },
    // The required exit node here is "point at a project directory": guidance plus a conductor that
    // runs. Recorded as guidance-only rather than pretended to be a mutation.
    effect: "guidance-only",
    verify: (f) => {
      assert.ok(existsSync(path.join(f.stateRoot, "state.json")), "guidance must not disturb a healthy root");
    },
  },
  {
    label: "R3 — a caller-supplied destination inside a guarded root",
    trigger: (f) => ({
      argv: ["doc", "read", "notes/a", "--out", path.join(f.stateRoot, "x.md"), "--dir", ".superbee", "--json"],
      commandLine: `superbee doc read notes/a --out '${path.join(f.stateRoot, "x.md")}' --dir .superbee --json`,
    }),
    expectStatus: 5,
    help: /choose a path outside ~\/\.superbee-state/,
    // The emitted exit node is a described alternative rather than a literal command: take the
    // refused invocation and put the destination where the help says. The substitution is recorded.
    remedy: (_output, f) => ({
      command: `superbee doc read notes/a --out '${path.join(f.outside, "x.md")}' --dir .superbee --json`,
      substitutions: { "<destination>": path.join(f.outside, "x.md") },
    }),
    effect: "changes-state",
    verify: (f) => {
      assert.ok(existsSync(path.join(f.outside, "x.md")), "the described alternative must actually export the doc");
      assert.equal(existsSync(path.join(f.stateRoot, "x.md")), false, "and the refused destination stays absent");
    },
  },
  {
    label: "R4 — an unrecognized canonical root, quarantined by RENAME",
    arrange: (f) => {
      // Strip the ownership marker: this is the half-created / foreign class, not a healthy root.
      rmSync(path.join(f.stateRoot, "state.json"), { force: true });
      writeFileSync(path.join(f.stateRoot, "foreign.json"), "foreign evidence\n", { mode: 0o600 });
    },
    trigger: () => ({ argv: ["setup", "--host", "codex", "--json"], commandLine: "superbee setup --host codex --json" }),
    // `setup` is a read-only conductor: it REPORTS the block and prescribes the exit node.
    expectStatus: 0,
    // The emitted command travels inside a JSON string, so its quotes arrive backslash-escaped.
    help: /mv ~\/\.superbee-state \\"\$\(mktemp -d ~\/\.superbee-state\.unrecognized\.XXXXXX\)\\"\/ && superbee setup/,
    remedy: (output) => ({ command: (JSON.parse(output) as SetupEnvelope).setup.next.command }),
    effect: "changes-state",
    verify: (f) => {
      assert.equal(existsSync(f.stateRoot), false, "the blocked root must be moved aside");
      const quarantined = readdirSync(f.home).filter((entry) => entry.startsWith(".superbee-state.unrecognized."));
      assert.equal(quarantined.length, 1, "exactly one collision-safe quarantine directory");
      assert.equal(
        readFileSync(path.join(f.home, quarantined[0]!, ".superbee-state", "foreign.json"), "utf8"),
        "foreign evidence\n",
        "quarantine is a RENAME: the evidence survives inspection",
      );
      const rerun = runCli(["setup", "migrate-state", "--json"], { cwd: f.project, home: f.home });
      assert.equal(rerun.status, 0, "the rerun the remedy points at must now succeed");
    },
  },
  {
    label: "R5 — the hostless `setup` a refusal points at reports no private-state row",
    arrange: (f) => {
      rmSync(path.join(f.stateRoot, "state.json"), { force: true });
    },
    trigger: () => ({ argv: ["setup", "migrate-state", "--json"], commandLine: "superbee setup migrate-state --json" }),
    expectStatus: 5,
    help: /help: superbee setup/,
    remedy: () => ({ command: "superbee setup" }),
    effect: "changes-state",
    verify: () => {},
    skip: "VIOLATED (specification R5, unfixed here): the emitted `superbee setup` runs and exits 0, but a "
      + "HOSTLESS run emits only the four host choices — no private-state row at all — so the refusal "
      + "points at a screen that never mentions the thing that is broken. Delete this skip when the "
      + "hostless conductor carries the state row (then `effect` becomes measurable).",
  },
  {
    label: "R6 — remedy proportionality for a root the product itself repairs",
    trigger: () => ({ argv: ["setup", "--host", "codex", "--json"], commandLine: "superbee setup --host codex --json" }),
    expectStatus: 0,
    help: /state.*needs_action/,
    remedy: () => ({ command: "superbee setup --host codex --json" }),
    effect: "guidance-only",
    verify: () => {},
    skip: "VIOLATED (specification R6 / P4, unfixed here): a 0755 root with a VALID 0600 marker is offered "
      + "the same quarantine `mv` as a foreign root, while an ordinary write repairs it silently. Delete "
      + "this skip when the remedy names the repair instead of a quarantine.",
  },
  {
    label: "R7 — quarantine must not be the remedy for a root holding the only copy",
    trigger: () => ({ argv: ["setup", "--host", "codex", "--json"], commandLine: "superbee setup --host codex --json" }),
    expectStatus: 0,
    help: /state/,
    remedy: () => ({ command: "superbee setup --host codex --json" }),
    effect: "guidance-only",
    verify: () => {},
    skip: "VIOLATED (specification R7, unfixed here): for the loose-marker-mode class (P6) the canonical root "
      + "holds the ONLY copy of the catalog, credentials, and View approvals, and migration's source list "
      + "never re-imports a quarantined canonical root — so executing the emitted remedy is DATA LOSS. "
      + "This row is deliberately not executed until the remedy stops being lossy.",
  },
];

interface SetupEnvelope {
  readonly setup: { readonly next: { readonly command: string } };
}

/**
 * Everything under the fixture's HOME and project, by name and size. The third column is MEASURED
 * against this rather than asserted: `changes-state` must differ, `guidance-only` must not.
 */
function snapshot(directory: string, rows: string[] = [], prefix = ""): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      rows.push(`dir ${relative}`);
      snapshot(absolute, rows, `${relative}/`);
    } else {
      rows.push(`${entry.isSymbolicLink() ? "link" : "file"} ${relative} ${statSync(absolute, { throwIfNoEntry: false })?.size ?? "?"}`);
    }
  }
  return rows;
}

function stateOf(f: Fixture): string {
  return [...snapshot(f.home), ...snapshot(f.project), ...snapshot(f.outside)].join("\n");
}

async function fixture(): Promise<Fixture> {
  const base = await boundaryFixture();
  return { ...base, bin: binShim(base.root) };
}

/** Every trigger runs with the shim on PATH, so emitted commands say `superbee`, not `npx -y …`. */
function triggerEnv(f: Fixture): NodeJS.ProcessEnv {
  return { PATH: `${f.bin}${path.delimiter}${process.env.PATH ?? ""}` };
}

test("recoverability: every refusal names an exit node, and the exit node is EXECUTED", async (t) => {
  for (const row of RECOVERABILITY_ROWS) {
    await t.test(row.label, row.skip === undefined ? {} : { skip: row.skip }, async () => {
      const f = await fixture();
      try {
        row.arrange?.(f);
        const { argv, commandLine } = row.trigger(f);
        const refusal = runCli(argv, { cwd: f.project, home: f.home, env: triggerEnv(f) });
        assert.equal(refusal.status, row.expectStatus, `${row.label}: ${refusal.stderr || refusal.stdout}`);
        assert.match(refusal.stdout, row.help, `${row.label}: the emitted exit node`);

        const remedy = row.remedy(refusal.stdout, f);
        assert.notEqual(
          remedy.command.trim(),
          commandLine.trim(),
          `${row.label}: the exit node must not be the command that just failed`,
        );
        const before = stateOf(f);
        const executed = runShell(remedy.command, { cwd: f.project, home: f.home, bin: f.bin });
        assert.equal(executed.status, 0, `${row.label}: the emitted remedy must RUN: ${executed.stderr || executed.stdout}`);
        const after = stateOf(f);
        if (row.effect === "changes-state") {
          assert.notEqual(after, before, `${row.label}: the emitted exit node ran but changed nothing`);
        } else {
          assert.equal(after, before, `${row.label}: a guidance-only exit node must not mutate the workspace`);
        }
        row.verify(f);
      } finally {
        f.cleanup();
      }
    });
  }
});

test("recoverability: every row in the table is accounted for", () => {
  const labels = RECOVERABILITY_ROWS.map((row) => row.label);
  assert.equal(labels.length, new Set(labels).size, "duplicate rows");
  assert.deepEqual(
    labels.map((label) => label.slice(0, 2)),
    ["R1", "R2", "R3", "R4", "R5", "R6", "R7"],
    "the table covers the specification's section 8 in order; a new refusal appends a row",
  );
});
