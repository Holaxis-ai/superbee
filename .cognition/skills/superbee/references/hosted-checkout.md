# Working in a hosted checkout

Read this when you work in a folder made by `superbee checkout`, or when `superbee sync` reports a
conflict there. The hosted bundle is the authority. The folder is a working copy. `superbee sync`
applies changes directly under the signed-in person's own access, and nobody has to approve them.

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
superbee sync --inspect <id>                  # base, your version, the host's version
superbee sync --resolve take --doc <id>       # use the host's version
superbee sync --resolve keep --doc <id>       # send yours over the inspected host version
superbee sync --resolve revise --doc <id>     # edit the file to the combined result first, then send it
superbee sync                                 # sends what keep or revise decided
```

- `keep` and `revise` need an `--inspect` first (`not_inspected` otherwise). If the host changes
  after the inspection, they refuse with `stale_review`: inspect again, and decide again.
- `keep` refuses a file edited since the conflict (`file_edited`). Use `revise` to send the file as
  it is now.
- To discard your edits with `take`, remove the file first if the command says it would discard
  them.
- If you cannot tell which version is right, ask the person. Do not merge by guessing.

## Deleting documents

Deleting a file (or running `superbee doc delete`) sends a delete of the version you had at the
next sync. The host keeps the document's history.

Deleting many files at once is held instead. The rule: when the deletes of the last day are more
than half the checkout and at least 3, the new ones are not sent. The sync receipt then carries
`deletions_held`, which names the held documents. The hold stays in place across syncs until the
person decides. Never accept it yourself:

1. Name the held documents to the person and ask whether they should be removed from the bundle.
   (A typed confirmation in the terminal is planned; until then, ask in the conversation.)
2. Only after an explicit yes, run `deletions_held.confirmation_required.command_after_confirmation`.
   That is `superbee sync --accept-deletes <count>:<digest>`, and the token covers exactly that set.
   If the set changes, the token no longer matches and nothing is accepted.
3. Otherwise run `superbee sync --restore-deletes`, which puts the files back. `--resolve take --doc
   <id>` restores a single file.

If the host deleted a document you edited, `--resolve keep` re-creates it, after an `--inspect`
that shows the deletion. If you deleted a document the host changed, `keep` deletes the host's
version (after `--inspect`), and `take` brings it back.

## Refusals that belong to the person

Some commands are refused in a hosted checkout with "do this in the Superbee app". Examples:
editing Kinds or recipes, artifacts, and `doc verify`. Tell the person what to do in the app. Do
not work around a refusal by editing files, using another command, or copying the bundle
somewhere else.

`sync_busy` means another command is working, or is just taking or releasing the lock: wait,
then retry, and never remove that lock. Only `lock_orphaned` means the lock's holder is gone:
confirm that no superbee command is still running, then remove the lock named in the help.

## Session hooks (opt-in)

- `superbee hook install` installs the SessionStart hook. In a hosted checkout, it pulls from the
  host at the start of each session.
- `superbee hook install --turn-end-sync` also installs a Stop hook for Claude Code and Codex. It
  syncs the checkout when each turn ends, and skips the network when nothing changed and the last
  pull is recent. If that sync finds a conflict, a held file or a sign-in link, the hook hands it
  back to you before the turn ends: handle it as above. It reports each condition once; the same
  unresolved condition is not reported on later turns, so check `superbee sync` yourself.
- Offer the Stop hook, but install it only when the person agrees.
  `superbee hook uninstall --turn-end-sync` removes it, and `SUPERBEE_NO_TURN_SYNC=<any value>`
  turns it off for a shell.
