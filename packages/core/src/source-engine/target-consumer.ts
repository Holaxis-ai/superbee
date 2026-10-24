/** An establishment replay must return to the adapter that interprets its descriptors. */
import type { CommitResult, PageCommit } from "./types.js";
import type { SourceCommitPreparation } from "./target.js";
type Prepare = (page: PageCommit) => Promise<SourceCommitPreparation>;
type Commit = (page: PageCommit) => Promise<CommitResult | void>;
const owners = new WeakMap<Commit, Prepare>();
/** Internal registration: only the target factory supplies these paired closures. */
export function registerSourceTargetConsumer(prepare: Prepare, commit: Commit): void {
  owners.set(commit, prepare);
}
export function isSourceTargetConsumer(prepare: Prepare | undefined, commit: Commit): boolean {
  return prepare !== undefined && owners.get(commit) === prepare;
}
