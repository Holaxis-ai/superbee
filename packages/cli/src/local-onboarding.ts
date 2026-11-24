// A scoped runtime may create a plain local bundle and documents. Git operations still require
// their own explicit board route. Inspect physical ancestors so a checkout subfolder or alias
// cannot turn into an independent local target.
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BOARD_REF, currentBranch, isDeclaredBoardBranch, probeRepoTopLevel, refCommit } from "@superbee/board-git";
import { detectBoardChannel } from "./board-runtime.js";
import { CONVENTIONAL_BUNDLE_DIR_NAME, resolveExistingGitBoardRoute, resolveLocalBundleTarget, resolveProjectBinding, scopedLocalRoute, type ScopedBundleRoute } from "./bundle.js";
import { cliInvocation } from "./invocation.js";
import { commandLiteral, type CommandText } from "./command-text.js";
import { CliError } from "./errors.js";
import { bindingForPath } from "./hosted/binding.js";
import { readCheckoutMarker } from "./hosted/marker.js";
import { unsafeProjectDir } from "./no-bundle-guidance.js";
import { assertBundleOutsidePrivateState } from "./private-state-bundle-boundary.js";
import { currentExistingGitBoard } from "./runtime-context.js";

async function inspectProjectAncestors(root: string): Promise<boolean> {
  let gitMarker = false;
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    if (readCheckoutMarker(cursor, true) || await bindingForPath(homedir(), cursor, true)) {
      throw new CliError("FORBIDDEN", "This folder belongs to a hosted checkout. Choose another folder for local setup.");
    }
    try {
      await lstat(path.join(cursor, ".git"));
      gitMarker = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path.dirname(cursor) === cursor) return gitMarker;
  }
}

async function inspectLocalProjectFolder(dir: string, purpose: "select" | "create"): Promise<"local" | "git"> {
  const root = await realpath(dir);
  assertBundleOutsidePrivateState(root);
  if (unsafeProjectDir(root, homedir())) throw new CliError("USAGE", "Choose a project folder outside your home root.");
  if (!(await inspectProjectAncestors(root))) return "local";
  const repo = probeRepoTopLevel(root);
  if (repo.kind !== "repo") throw new CliError("CONFLICT", "Unable to inspect this Git checkout. Restore Git access before local setup.");
  if (isDeclaredBoardBranch(repo.top, currentBranch(repo.top))) return "git";
  // Existing bundles have a home on disk. Only creating a new one needs to establish whether
  // a shared board already serves the project before minting a potentially divergent bundle.
  const board = detectBoardChannel(repo.top, purpose === "select"
    ? { remoteBoardState: top => refCommit(top, `refs/remotes/${BOARD_REF}`) ? "exists" : "absent" }
    : { budget: { fetchTimeoutMs: 2000, connectTimeoutSeconds: 2 } });
  if (board.kind === "indeterminate") throw new CliError("CONFLICT", board.reason);
  return board.channel.mode === "local-only" ? "local" : "git";
}

export async function assertLocalCreationProject(project: string): Promise<void> {
  const root = await realpath(project);
  const target = path.join(root, CONVENTIONAL_BUNDLE_DIR_NAME);
  if (await bindingForPath(homedir(), target, true)) {
    throw new CliError("FORBIDDEN", "The selected target is a hosted checkout. Choose another folder for local setup.");
  }
  if (await inspectLocalProjectFolder(root, "create") === "git" || await resolveProjectBinding(root)) {
    throw new CliError("CONFLICT", "This project already selects a board or bundle. Open its existing standalone checkout or choose another local project.");
  }
}

export async function resolveOnboardingRoute(
  dir: string | undefined,
  usage: CommandText = commandLiteral("setup --help"),
  project?: string,
): Promise<ScopedBundleRoute> {
  if (!dir?.trim()) throw new CliError("USAGE", "Select the local bundle or standalone board with --dir.", { help: `${cliInvocation()} setup` });
  const target = await resolveLocalBundleTarget(dir);
  // A project binding or a conventional child can select a root outside the physical project.
  // Keep the source of that selection inside the same local-only boundary.
  const source = await realpath(project ?? dir);
  if (path.relative(source, target.canonicalRoot) !== "") await inspectProjectAncestors(source);
  if (await inspectLocalProjectFolder(target.canonicalRoot, "select") === "git") return resolveExistingGitBoardRoute(dir, usage);
  return scopedLocalRoute(target);
}

/** The scoped CLI accepts an explicit Hosted root only while its local binding is valid. */
export async function scopedHostedCheckoutRoute(dir: string | undefined): Promise<ScopedBundleRoute | null> {
  if (!currentExistingGitBoard()?.hostedOnboarding || !dir?.trim()) return null;
  const root = path.resolve(dir);
  const canonicalRoot = await realpath(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (canonicalRoot === null || !await bindingForPath(homedir(), canonicalRoot, true)) return null;
  assertBundleOutsidePrivateState(canonicalRoot);
  return scopedLocalRoute({ root, canonicalRoot, selectedBy: "explicit-dir" });
}
