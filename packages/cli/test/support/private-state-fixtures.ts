// Shared fixture builders for the private-state / bundle boundary tables.
//
// The boundary specification's section 9 asks one thing of these tests: a newly discovered
// behavior must be a ROW someone adds, not a bespoke harness they have to design. That only holds
// if every table is driven by ONE fixture builder, so the builders live here and the row tables
// stay declarative.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureUserStateRoot } from "../../src/user-state.js";
import { isolatedUserEnv } from "./user-env.js";

/** The BUILT CLI: every crossing-point row exercises the artifact users actually run. */
export const BUILT_CLI = fileURLToPath(new URL("../../dist/superbee.mjs", import.meta.url));

export function scratch(prefix = "superbee-private-state-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function runCli(
  argv: readonly string[],
  options: { cwd: string; home: string; env?: NodeJS.ProcessEnv },
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BUILT_CLI, ...argv], {
    cwd: options.cwd,
    env: isolatedUserEnv(options.home, {
      ASLITE_NO_UPDATE_CHECK: "1",
      SUPERBEE_NO_UPDATE_CHECK: "1",
      AGENTSTATE_LITE_NO_AUTOPULL: "1",
      SUPERBEE_NO_AUTOPULL: "1",
      ...options.env,
    }),
    encoding: "utf8",
  });
}

/**
 * A PATH directory whose `superbee` entry resolves to the built CLI, so an emitted `help:` command
 * can be executed CHARACTER-FOR-CHARACTER (`cliInvocation()` returns the bare bin name only when a
 * managed bin on PATH realpaths to the running executable).
 */
export function binShim(root: string): string {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "superbee.cmd"), `@echo off\r\n"${process.execPath}" "${BUILT_CLI}" %*\r\n`);
  } else {
    symlinkSync(BUILT_CLI, path.join(bin, "superbee"));
  }
  return bin;
}

/** Run a shell command line VERBATIM with the shim on PATH — for executing an emitted remedy. */
export function runShell(
  command: string,
  options: { cwd: string; home: string; bin: string },
): SpawnSyncReturns<string> {
  return spawnSync(
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "sh",
    process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
    {
    cwd: options.cwd,
    env: isolatedUserEnv(options.home, {
      ASLITE_NO_UPDATE_CHECK: "1",
      SUPERBEE_NO_UPDATE_CHECK: "1",
      AGENTSTATE_LITE_NO_AUTOPULL: "1",
      SUPERBEE_NO_AUTOPULL: "1",
      PATH: `${options.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    }),
    encoding: "utf8",
    },
  );
}

export interface BoundaryFixture {
  /** Throwaway root containing everything the fixture created. */
  readonly root: string;
  readonly home: string;
  readonly project: string;
  /** The project's bundle directory (`<project>/.superbee`). */
  readonly bundle: string;
  /** The ready canonical private-state root under `home`. */
  readonly stateRoot: string;
  /** A credential-shaped record inside the state root — the thing ingress must never publish. */
  readonly credential: string;
  /** An ordinary project file: the benign counterpart of `credential`. */
  readonly ordinaryFile: string;
  /** An ordinary HTML file, for `artifact create`. */
  readonly ordinaryHtml: string;
  /** A directory outside every guarded root, for control (benign-target) invocations. */
  readonly outside: string;
  cleanup(): void;
}

/**
 * A real bundle plus a ready private-state root, both under one throwaway HOME. Every crossing
 * point row runs against this ONE fixture so the refusal and its control differ only in the path.
 */
export async function boundaryFixture(): Promise<BoundaryFixture> {
  const root = scratch();
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const stateRoot = await ensureUserStateRoot(home);

  const credential = path.join(stateRoot, "okf-config.json");
  writeFileSync(credential, '{"remotes":{"x":{"api_key":"secret"}}}\n', { mode: 0o600 });
  const ordinaryFile = path.join(project, "ordinary.md");
  writeFileSync(ordinaryFile, "# Summary\n\nordinary project content\n");
  const ordinaryHtml = path.join(project, "ordinary.html");
  writeFileSync(ordinaryHtml, "<!doctype html><title>Probe</title><p>ordinary project content</p>\n");

  const initialized = runCli(["init", "--create-only", "--dir", ".superbee", "--json"], { cwd: project, home });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  for (const id of ["notes/a", "notes/b"]) {
    const wrote = runCli(
      ["doc", "write", id, "--type", "Note", "--body", "body", "--dir", ".superbee", "--json"],
      { cwd: project, home },
    );
    assert.equal(wrote.status, 0, wrote.stderr || wrote.stdout);
  }

  return {
    root,
    home,
    project,
    bundle: path.join(project, ".superbee"),
    stateRoot,
    credential,
    ordinaryFile,
    ordinaryHtml,
    outside,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
