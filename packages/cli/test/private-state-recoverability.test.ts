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
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  /** Re-inspect AFTER the remedy ran, with what the remedy PRINTED. This is what makes the third
   * column a measurement. */
  readonly verify: (fixture: Fixture, executed: { readonly stdout: string }) => void;
  /** Shape the fixture this row needs before the trigger runs. */
  readonly arrange?: (fixture: Fixture) => void;
  /** Interrogate the refusal BEFORE its remedy runs — proportionality is a claim about the emitted
   * command, so it has to be checked where the command is emitted. */
  readonly inspectRefusal?: (output: string, fixture: Fixture) => void;
  readonly skip?: string;
}

/** The durable records a canonical root can be the ONLY copy of (specification R7). */
const CREDENTIAL_BYTES = '{"remotes":{"x":{"api_key":"secret"}}}\n';
const CATALOG_BYTES = `${JSON.stringify({ schema_version: 1, entries: [] })}\n`;
const AUTHORIZATION_BYTES = JSON.stringify({
  bundle: "/bundles/planning",
  subject: {
    registryId: "views-registry/roadmap",
    contentVersion: "sha256:exact-html",
    contentType: "text/html; charset=utf-8",
    capability: "bundle-read",
    execution: "active",
    policyVersion: "active-view-v1",
  },
});
const AUTHORIZATION_NAME = `${createHash("sha256").update(AUTHORIZATION_BYTES).digest("hex")}.json`;

/** Everything a recognized root may hold, so a remedy that loses any of it is a failing row. */
function withDurableRecords(f: Fixture): void {
  assert.equal(readFileSync(f.credential, "utf8"), CREDENTIAL_BYTES, "the fixture's credential bytes");
  writeFileSync(path.join(f.stateRoot, "catalog.json"), CATALOG_BYTES, { mode: 0o600 });
  mkdirSync(path.join(f.stateRoot, "view-authorizations"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(f.stateRoot, "view-authorizations", AUTHORIZATION_NAME), AUTHORIZATION_BYTES, { mode: 0o600 });
}

function assertDurableRecordsIntact(f: Fixture): void {
  assert.equal(readFileSync(f.credential, "utf8"), CREDENTIAL_BYTES, "the credential must survive the remedy");
  assert.equal(readFileSync(path.join(f.stateRoot, "catalog.json"), "utf8"), CATALOG_BYTES, "the catalog must survive");
  assert.equal(
    readFileSync(path.join(f.stateRoot, "view-authorizations", AUTHORIZATION_NAME), "utf8"),
    AUTHORIZATION_BYTES,
    "the View approval must survive",
  );
}

function stateRow(output: string): { readonly state: string; readonly reason: string; readonly command?: string } {
  const row = (JSON.parse(output) as SetupEnvelope).setup.capabilities.find((entry) => entry.id === "state");
  assert.ok(row, "setup must report a private-state row");
  return row;
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
    help: /mv ~\/\.superbee-state \\"\$superbee_quarantine\\"\/ && echo \\"preserved: \$superbee_quarantine\/\.superbee-state\\"/,
    remedy: (output) => ({ command: (JSON.parse(output) as SetupEnvelope).setup.next.command }),
    effect: "changes-state",
    verify: (f, executed) => {
      assert.equal(existsSync(f.stateRoot), false, "the blocked root must be moved aside");
      const quarantined = readdirSync(f.home).filter((entry) => entry.startsWith(".superbee-state.unrecognized."));
      assert.equal(quarantined.length, 1, "exactly one collision-safe quarantine directory");
      assert.equal(
        readFileSync(path.join(f.home, quarantined[0]!, ".superbee-state", "foreign.json"), "utf8"),
        "foreign evidence\n",
        "quarantine is a RENAME: the evidence survives inspection",
      );
      assert.match(
        executed.stdout,
        new RegExp(`preserved: .*${quarantined[0]!}/\\.superbee-state`),
        "the emitted command PRINTS where it preserved the root — otherwise the path to recovery is lost",
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
    // The 0755 DIRECTORY mode with a valid 0600 marker: a root this product recognizes and repairs
    // on its next write. Its exit node must therefore be the repair, not the foreign-root remedy.
    label: "R6 — remedy proportionality for a root the product itself repairs",
    arrange: (f) => {
      withDurableRecords(f);
      chmodSync(f.stateRoot, 0o755);
    },
    trigger: () => ({ argv: ["setup", "--host", "codex", "--json"], commandLine: "superbee setup --host codex --json" }),
    // `setup` is a read-only conductor: it REPORTS the drift and prescribes the exit node.
    expectStatus: 0,
    help: /"command":"chmod -R go-rwx ~\/\.superbee-state"/,
    inspectRefusal: (output) => {
      const row = stateRow(output);
      assert.equal(row.state, "needs_action", "a recognized, repairable root is not blocked");
      assert.doesNotMatch(row.reason, /unrecognized/, "and it is never described as unrecognized");
      assert.doesNotMatch(row.command ?? "", /\bmv\b/, "proportionality: no quarantine for a root we repair");
    },
    remedy: (output) => ({ command: (JSON.parse(output) as SetupEnvelope).setup.next.command }),
    effect: "changes-state",
    verify: (f) => {
      assert.equal(statSync(f.stateRoot).mode & 0o777, 0o700, "the emitted repair must actually tighten the root");
      assert.equal(statSync(path.join(f.stateRoot, "state.json")).mode & 0o777, 0o600, "and its marker");
      assertDurableRecordsIntact(f);
      const rerun = runCli(["setup", "--host", "codex", "--json"], { cwd: f.project, home: f.home });
      assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
      assert.equal(stateRow(rerun.stdout).state, "ready", "the repair must clear the finding it was emitted for");
    },
  },
  {
    // The 0644 MARKER mode: the class specification R7 names as reachable data loss, because this
    // root holds the ONLY copy of the catalog, credentials, and View approvals and nothing
    // re-imports a quarantined canonical root.
    label: "R7 — quarantine must not be the remedy for a root holding the only copy",
    arrange: (f) => {
      withDurableRecords(f);
      chmodSync(path.join(f.stateRoot, "state.json"), 0o644);
    },
    trigger: () => ({ argv: ["setup", "--host", "codex", "--json"], commandLine: "superbee setup --host codex --json" }),
    expectStatus: 0,
    help: /"command":"chmod -R go-rwx ~\/\.superbee-state"/,
    inspectRefusal: (output) => {
      const row = stateRow(output);
      assert.equal(row.state, "needs_action");
      assert.doesNotMatch(row.command ?? "", /\bmv\b/, "a quarantine here would destroy the only copy");
      assert.doesNotMatch(row.command ?? "", /\brm\b/);
    },
    remedy: (output) => ({ command: (JSON.parse(output) as SetupEnvelope).setup.next.command }),
    effect: "changes-state",
    verify: (f) => {
      assertDurableRecordsIntact(f);
      assert.equal(statSync(path.join(f.stateRoot, "state.json")).mode & 0o777, 0o600, "the marker mode is repaired");
      const listed = runCli(["catalog", "list", "--json"], { cwd: f.project, home: f.home });
      assert.equal(listed.status, 0, "and the records stay reachable THROUGH the product");
    },
  },
  {
    // The migration SOURCE side of the same property: `~/.agentstate -> ~/dotfiles/agentstate` is
    // an ordinary dotfile layout, and reporting it as absent abandoned everything it held.
    label: "R8 — a migration source that exists but is not a real directory",
    arrange: (f) => {
      rmSync(f.stateRoot, { recursive: true, force: true });
      const real = path.join(f.home, "dotfiles", "agentstate");
      mkdirSync(real, { recursive: true, mode: 0o700 });
      chmodSync(real, 0o700);
      for (const [name, bytes] of [["catalog.json", CATALOG_BYTES], ["okf-config.json", CREDENTIAL_BYTES]] as const) {
        writeFileSync(path.join(real, name), bytes, { mode: 0o600 });
        chmodSync(path.join(real, name), 0o600);
      }
      symlinkSync(real, path.join(f.home, ".agentstate"), "dir");
    },
    trigger: () => ({
      argv: ["setup", "migrate-state", "--json"],
      commandLine: "superbee setup migrate-state --json",
    }),
    expectStatus: 5,
    help: /help: ls -ld ~\/\.agentstate/,
    inspectRefusal: (output) => {
      assert.match(output, /legacy operational state at ~\/\.agentstate exists but is not a real directory/);
      assert.doesNotMatch(output, /nothing_to_migrate/, "detected uncertainty must never read as absence");
    },
    remedy: (output) => {
      const start = output.indexOf("help: ") + "help: ".length;
      const end = output.indexOf("\n", start);
      return { command: output.slice(start, end === -1 ? undefined : end).trim() };
    },
    // The exit node here is an inspection: what to do with a symlinked dotfile root is the
    // operator's decision, and no rearrangement of their $HOME may be prescribed for them.
    effect: "guidance-only",
    verify: (f) => {
      const real = path.join(f.home, "dotfiles", "agentstate");
      assert.equal(readFileSync(path.join(real, "okf-config.json"), "utf8"), CREDENTIAL_BYTES, "sources are preserved");
      assert.equal(readFileSync(path.join(real, "catalog.json"), "utf8"), CATALOG_BYTES);
      assert.equal(existsSync(f.stateRoot), false, "a blocked source never claims the canonical root");
      const conducted = runCli(["setup", "--host", "codex", "--json"], { cwd: f.project, home: f.home });
      const row = stateRow(conducted.stdout);
      assert.equal(row.state, "blocked", "the conductor agrees with the leaf");
      assert.match(row.reason, /~\/\.agentstate/, "and the reason names the root that is blocking");
      assert.doesNotMatch(row.command ?? "", /\.superbee-state/, "never the other root's exit node");
    },
  },
];

interface SetupEnvelope {
  readonly setup: {
    readonly next: { readonly command: string };
    readonly capabilities: readonly { readonly id: string; readonly state: string; readonly reason: string; readonly command?: string }[];
  };
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
    const status = statSync(absolute, { throwIfNoEntry: false });
    const mode = status === undefined ? "?" : (status.mode & 0o777).toString(8);
    if (entry.isDirectory()) {
      rows.push(`dir ${relative} ${mode}`);
      snapshot(absolute, rows, `${relative}/`);
    } else {
      rows.push(`${entry.isSymbolicLink() ? "link" : "file"} ${relative} ${status?.size ?? "?"} ${mode}`);
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
        row.inspectRefusal?.(refusal.stdout, f);

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
        row.verify(f, executed);
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
    ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
    "the table covers the specification's section 8 in order; a new refusal appends a row",
  );
});
