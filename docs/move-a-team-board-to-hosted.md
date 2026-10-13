# Move a team's Git board to hosted Superbee

A Git board is a bundle shared on the `board` branch of a project's repository. Moving it to hosted
Superbee makes the hosted bundle the one place the team edits, and stops the board from taking new
changes. This guide is for the person who moves it. Every command takes `--host <url>` when you are
signed in to more than one host.

## 1. Publish the board

Sync the board first, so teammates' latest changes travel too. Then preview the move, and run it:

```sh
superbee sync
superbee publish --to hosted                       # preview: what travels, what stays, no network
superbee publish --to hosted --bundle-id <id> --yes
```

Add `--with-history` to bring each document's Git history along as labeled, unverified versions.

`--yes` fetches the board's latest state, creates the hosted bundle in your workspace, converts
the board folder in place into a hosted checkout, and, for a board shared on origin, commits and
pushes a moved marker (`.superbee-moved-to-hosted.json`) on the `board` branch. The branch and its
history stay where they were, locally and on origin. A board never pushed to origin has no
teammates to stop, so it gets no marker.

If the receipt says the marker push was rejected, a teammate pushed to the board after your
snapshot, and their commits are not in the hosted bundle. The receipt's `recovery` lists the exact
commands: `git -C <project> log board..origin/board` shows their commits; copy those changes into
your hosted checkout and sync; then the remaining commands put the marker on top of theirs from a
temporary worktree of the board branch and push it.

## 2. Share it with each teammate

Only you can reach the new bundle until you share it. A workspace admin shares it from the CLI (or
in the app):

```sh
superbee access grant <id> ana@example.com --level write          # preview
superbee access grant <id> ana@example.com --level write --yes
superbee access list <id>
```

A teammate must already be a member of the workspace: invite them from the Members page in the
Superbee app first. `access revoke <id> <email> --yes` takes access away. Repeating a grant or a
revoke changes nothing, so a re-run is always safe.

## 3. Teammates switch to the hosted checkout

Each teammate checks the bundle out into a new folder and uses that from then on:

```sh
superbee checkout <id> --dir <new folder>
```

What the moved marker does for them depends on their CLI:

- **A CLI with the moved marker**: their next `superbee sync` (and the turn-end hook that runs it)
  pulls the marker, refuses to push to the board, and prints the checkout command. Their unpushed
  work stays in their board folder, to copy into the new checkout. If checkout says the bundle is
  not found, they have not been shared it yet: the refusal names you and the `access grant`
  command to ask you for.
- **An older CLI**: nothing stops it. Its `sync` keeps pushing to the board, and those changes never
  reach the hosted bundle. Until everyone has updated (`npm install -g superbee`), protect the
  `board` branch on GitHub (Settings, Branches: a rule that blocks pushes to `board`).

## 4. Move the automations

Anything that wrote to the board writes to the hosted checkout instead:

- **Scheduled agents** that ran `superbee sync` in the board folder: point them at a hosted
  checkout folder on the machine they run on.
- **Skills and scripts that write to the board** (an import skill that files meeting notes, for
  example): change the folder they write into to the hosted checkout, and keep their `superbee sync`
  step.
- **Hooks**: `superbee hook install --turn-end-sync` syncs a hosted checkout at the end of each
  turn; `--git-boards` is no longer needed for this bundle.

## Roll back

The hosted bundle can be copied back out as a Git board at any time:

```sh
superbee export <id> --to <folder> --git
```

That writes the bundle's current documents into a new folder and commits them on a `board` branch.

To make the old board live again instead, revert the marker commit on the `board` branch and push
it (from a worktree of the branch: `git revert <marker commit>`, then `git push origin board`).
Teammates' next `superbee sync` checks origin first, sees the marker is gone, and syncs as before,
replaying any commits they made meanwhile. (`superbee sync --pull-only` also brings the revert in:
a pull-only sync never pushes, so the marker never stops it.) Changes made in the hosted bundle
since the move are only in an export, not on the old branch.
