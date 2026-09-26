# Working in a hosted checkout

Read this when you work in a folder made by `superbee checkout`, or when `superbee sync` reports a
conflict there. The hosted bundle is the authority. The folder is a working copy. `superbee sync`
applies changes directly under the signed-in person's own access, and nobody has to approve them.

## Finding a bundle to check out

`superbee catalog list --hosted` lists the hosted bundles the signed-in person can reach on the
host of their last sign-in (or `--host <url>`), across all their workspaces. Each row has the
`bundle_id` that `superbee checkout <bundle-id>` takes, its `name` and `lifecycle`, the `folder` of
an existing checkout here (null when there is none), and `ambiguous: true` when two of their
workspaces hold the same id, which checkout refuses. If a bundle already has a `folder`, work there
with `--dir` instead of checking it out again. The list is read live and never cached.

## The folder marker, and adopting a moved or copied checkout

A checkout folder carries a read-only `.superbee/checkout.json` naming its host and bundle. It is a
note for you and the person, never an authority: nothing reads it to decide where a command goes.
The checkout is bound by private state, keyed by the folder's path.

When `status`, `home`, `bundle locate` or `session-start` report `copy_of_checkout` (and `home:
local`), the folder was moved, copied or restored, and it is not bound here. It behaves as a plain
local bundle, and `sync` refuses it (`unbound_copy`). Tell the person, then:

- `superbee checkout --adopt <folder>` binds a folder moved on the same disk back to its own
  checkout, with no network. Unsent edits and conflicts carry over.
- For a copy or a restore, the same command only previews. Adopting it needs `--host <url>`, and
  the person should confirm the host: never take the marker's host on its own. Adopt adds the
  documents the folder lacks and never overwrites a file. A file that differs from the host's
  version becomes a conflict (below), and a document only in the folder is sent as new by the next
  sync, so check its `local_only` list with the person first.

## Moving a local bundle or Git board to hosted

`superbee publish --to hosted` moves a bundle to hosted Superbee in the person's own workspace.
Only run it when the person asks for the move.

1. Run it without `--yes` first. It makes no request. It lists what travels (documents, reserved
   files, other files), what stays (dot-files, links), anything that blocks the move, and the
   bundle id and host it will use. Show the person the preview. A document that does not satisfy
   its Kind, or a Kind convention with a problem, blocks the move, because the host would refuse
   writes to it. Fix them before publishing.
2. When they agree, run the `--yes` command the preview names. It signs in if needed (relay the
   link, as below), creates the bundle, and converts the folder in place into a hosted checkout.
   No file is rewritten.
3. A Git board is unbound from its `board` branch, but the branch stays, locally and on origin.
   Tell the person their teammates keep using the Git board until they check out the hosted bundle
   instead. A board that is behind its upstream is refused until `superbee sync` brings it current.
4. `--with-history` imports a Git board's earlier versions as labeled, unverified history. Use it
   only when the person asks for history.
5. `TRANSIENT` with `write_outcome_unknown` means the creation may be partial: re-run the same
   command, which finishes or confirms the same creation.

## Sign-in: relay the link, then retry

Hosted commands start sign-in by themselves. When a command returns `AUTH_REQUIRED` (exit 4):

1. Give the person `details.sign_in_url` and `details.user_code` exactly as returned.
2. Wait until they say they have confirmed.
3. Run the same command again (`details.resume`). It finishes sign-in and continues.

Never ask for a password, token or code the person did not see in their browser.
`superbee setup hosted` signs in and records the default hosted workspace in one step. If the
receipt says `choose_workspace`, ask the person which workspace to use, then run the command it
lists for that workspace.

## Sync at the end of a batch of edits

Edit files as usual, then run `superbee sync` once when a batch of related edits is done, not after
every file. Sync always pulls before it sends. Its receipt has one row per document:
`committed`, `conflict`, `held`, `refused`, `unknown` or `paused`. It exits 0 only when every row is
committed.

Reads keep the folder current on their own:
- `list`, `doc read`, `status`, `home`, `link show` and `view list` pull first when the last pull
  is more than five minutes old. They wait at most two seconds and never send anything.
- These pulls never start a sign-in. When you are signed out, they print a note on stderr and skip
  the pull. Run `superbee sync`, which returns the sign-in link to relay.
- When the last pull is more than thirty minutes old, they print a warning on stderr. Run sync
  then.
- `SUPERBEE_NO_AUTOPULL=<any value>` turns these pulls off.

## Conflicts: inspect, then keep, take or revise

Changes to different documents merge automatically. Any concurrent change to the same document,
even to different frontmatter keys, comes back as a `conflict` row, and nothing is sent for that
document until you resolve it:

```sh
superbee sync --inspect --doc <id>            # base, your version, the host's version
superbee sync --resolve take --doc <id>       # use the host's version
superbee sync --resolve keep --doc <id>       # send yours over the inspected host version
superbee sync --resolve revise --doc <id>     # edit the file to the combined result first, then send it
superbee sync                                 # sends what keep or revise decided
```

- `--resolve` only records the decision in the checkout. It never sends anything: its receipt
  says `sent: false`, and after `keep` or `revise` its `next` and `help` name the `superbee sync`
  that sends it. `take` has nothing to send.
- `keep` or `revise` again before that sync answers `already_resolved: true` ("waiting to send");
  the first decision stands. `take` after an unsent `keep` or `revise` replaces it (`replaces`),
  and nothing is sent. When the change may already have been sent, `take` is refused
  (`resolution_not_replaceable`): run `superbee sync`, then resolve any conflict it reports.

- `keep` and `revise` need an `--inspect` first (`not_inspected` otherwise). If the host changes
  after the inspection, they refuse with `stale_review`: inspect again, and decide again.
- `--inspect <id>` is an alias of `--inspect --doc <id>`.
- `keep` refuses a file edited since the conflict (`file_edited`). Use `revise` to send the file as
  it is now.
- To discard your edits with `take`, remove the file first if the command says it would discard
  them.
- If you cannot tell which version is right, ask the person. Do not merge by guessing.

## Document history

In a checkout, `superbee doc history <id>` reads the host's version chain, not the folder: every
sent version, newest first, with its `seq`, the principal id that made it, and the agent label
the write named. `count` is the host's total; `--limit 0` lists them all. `superbee doc history
<id> --seq <n>` prints version `n`'s full content. A document created in the folder has history
once `superbee sync` sends it. To compare-and-swap, use the folder's own version from `doc read`,
not the host's newest version.

## Deleting documents

Deleting a file (or running `superbee doc delete`) sends a delete of the version you had at the
next sync. The host keeps the document's history.

Deleting many files at once is held instead. The rule: when the deletes of the last day are more
than half the checkout and at least 3, the new ones are not sent. The same rule is applied to the
documents this checkout did not create itself, so documents it added earlier never dilute the
count. The sync receipt then carries `deletions_held`, which names the held documents. The hold
stays in place across syncs until the person decides. Accepting it is the person's step, never
yours:

1. Name the held documents to the person, and ask whether they should be removed from the bundle.
2. If they want them removed, give them `deletions_held.confirmation_required.command_for_person`
   (`superbee sync --accept-deletes <count>:<digest>`) to run in their own terminal. It lists the
   documents and asks them to type the count. The token covers exactly that set; if the set
   changes, nothing is accepted.
3. Do not run it yourself. In a shell without a terminal it is refused with `FORBIDDEN`
   `needs_person_at_terminal` (exit 2), and nothing is accepted. Do not retry it or work around it.
   The check keeps the person in the loop; it is not a security boundary. A pseudo-terminal
   (`script`, `expect`), typing into their terminal (`tmux send-keys`) or importing the CLI with
   another terminal would get past it, and each of those is a violation of this rule.
4. Otherwise run `superbee sync --restore-deletes`, which puts the files back. `--resolve take --doc
   <id>` restores a single file. Both work from your shell.

If the host deleted a document you edited, `--resolve keep` re-creates it, after an `--inspect`
that shows the deletion. If you deleted a document the host changed, `keep` deletes the host's
version (after `--inspect`), and `take` brings it back.

When the host no longer lists most of the documents the folder holds (8 or more, and more than
half, or all of them), the pull removes none of them and the receipt carries
`pulled.refused_deletions`: a bundle emptied or replaced by mistake looks the same. Tell the person.
Once they confirm, in the Superbee app, that the bundle really shrank, run its `take` command
(`superbee sync --take-host-deletions <count>:<digest>`). It removes the files of exactly that set
and keeps any file you edited. Nothing is sent to the host.

A host document whose id cannot be a file in the folder (a path-like id such as `a/../b`) is held
with a `held` row, reason `unsafe_id`, and the rest of the bundle syncs. A host document whose id
differs only in letter case from another is held as `case_collision`. Both are renamed in the
Superbee app, by the person.

## Refusals that belong to the person

Some commands are refused in a hosted checkout with "do this in the Superbee app". Examples:
artifacts and `doc verify`. Tell the person what to do in the app. Editing Kinds or recipes is
refused too, and the app cannot do it either: a hosted bundle's Kinds cannot be changed from a
checkout. Kinds are designed in a local or Git bundle before it is published. Do not work around a
refusal by editing files, using another command, or copying the bundle somewhere else. Taking a
bundle out of hosted is `superbee export` (below), and only when the person asks for it.

`checkout` adds the folder to the workspace catalog, where `catalog list` shows it with
`home: hosted`. The local MCP app (`superbee mcp`) can read it by that label, but refuses every
write there with the same "do this in the Superbee app": Views and documents written through it
could not sync.

`sync_busy` means another command is working, or is just taking or releasing the lock: wait,
then retry, and never remove that lock. Only `lock_orphaned` means the lock's holder is gone:
confirm that no superbee command is still running, then remove the lock named in the help.

## Session hooks (opt-in)

- `superbee hook install` installs the SessionStart hook. In a hosted checkout, it pulls from the
  host at the start of each session. Its `workspaces` block lists the other catalog bundles with
  their `home` (local, git or hosted) and `freshness` (when each was last pulled or fetched). It
  pulls none of them: to work in one, get its path with `superbee catalog resolve <label> --field
  path` and pass `--dir`, and sync a stale one only when the work needs it.
- `superbee hook install --turn-end-sync` also installs a Stop hook for Claude Code and Codex. It
  syncs the checkout when each turn ends, and skips the network when nothing changed and the last
  pull is recent. If that sync finds a conflict, a held file or a sign-in link, the hook hands it
  back to you before the turn ends: handle it as above. It reports each condition once; the same
  unresolved condition is not reported on later turns, so check `superbee sync` yourself.
- A Git board is never synced by the Stop hook unless the person also asks for it:
  `superbee hook install --turn-end-sync --git-boards`. Then the shared board the session is in
  syncs at turn end under the same rules, and a conflict comes back once, in Git's form: the
  teammate's version is kept and yours is saved to the export file the reason names.
- Offer the Stop hook, but install it only when the person agrees.
  `superbee hook uninstall --turn-end-sync` removes it, and `SUPERBEE_NO_TURN_SYNC=<any value>`
  turns it off for a shell.
- Each write names the agent the sync runs under, and the host records it with the write as
  unverified attribution, never authority: `claude-code` under Claude Code (`CLAUDECODE=1`), or
  `SUPERBEE_VIA=<token>` (1 to 32 of `a-z 0-9 . _ -`, not starting with `superbee`).
  `SUPERBEE_NO_VIA=<any value>` names none. Another agent started from a Claude Code shell (a
  Codex in a tmux pane, for example) inherits `CLAUDECODE=1` and is named `claude-code` unless
  `SUPERBEE_VIA` is set. A token the host would refuse is not sent, and the receipt says so
  (`via_ignored`).

## Export: taking a bundle out of hosted

Run `superbee export` only when the person asks for a copy outside hosted, or to stop using a
checkout. It never changes the hosted bundle, and it carries the current revision only, never
history.

- `superbee export <bundle-id> --to <folder>` (or `--dir <checkout> --to <folder>`) writes every
  document, reserved file and blob into a new or empty folder, which becomes an ordinary local
  bundle. The archive is verified against the host's digests first, and the folder appears
  complete or not at all. `export_incomplete` (TRANSIENT) means the host stopped the export:
  retry the same command.
- `superbee export --dir <checkout> --in-place` turns the checkout into a local bundle: it adds
  the files the checkout lacks, never overwrites one (`kept_local` lists files that differ from
  the host's), and forgets the binding. It refuses `unsent_changes`: run `superbee sync` first. Pass
  `--keep-unsent` only when the person agrees that those changes stay in this folder and never
  reach the host. If it stops part way, re-run the same command: it finishes without the network.
- `--git` makes the result a Git board on branch `board`. To share it, the person adds a remote
  (`git remote add origin <url>`), then `superbee sync --establish`.
