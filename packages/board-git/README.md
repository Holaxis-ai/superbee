# `@superbee/board-git` — the board's git channel

The public-boundary ACCEPTANCE BAR for this package, written down at A0 (before the move, as
`packages/cli/src/board-git-API.md`) and delivered by A1 (`plans/board-git-package` on the
project bundle). The extraction is judged against this contract.

## What the package exports

Domain-neutral operations, typed results, and injected stores/adapters:

- **Porcelain ops** (`src/porcelain.ts`): the ONE spawn wrapper (`runGit`/`runGitBytes`, plus the
  throw-on-failure `mustGit`) and the named ops — provisioning/self-heal, stage-and-commit,
  converging fetch-rebase, ff-pull, push, `currentHead`, `countUncommitted`, `unpushedCount`.
  Channel constants (`BOARD_BRANCH`/`BOARD_REMOTE`/`BOARD_REF`/`BUNDLE_DIR`) are the
  `branch`-mode defaults of the BoardChannel seam (`src/channel.ts`).
- **Channel detection** (`src/channel.ts`, PR B): the `BoardChannel` union — `branch` (defaults
  `board`/`origin` from the porcelain constants), `in-tree`, `local-only` — and
  `detectBoardChannel`, a READ-ONLY classifier (injected remote probe for tests) that composes
  AFTER the provisioning state machine's heal/repair steps and never re-routes its reviewed
  guidance. Remote-unknown FAILS CLOSED: a dead probe is a typed indeterminate outcome, never
  "absent", never `in-tree`, never `local-only`.
- **In-tree read-side mechanics** (`src/intree.ts`, PR C): the supported semantics for a bundle
  committed with code on the current branch — the upstream DECISION TABLE (tracking config or an
  explicit no-comparison-basis outcome; never a guessed `origin/<branch>`), the mode-scoped
  cursor tier (`git-intree`), prefix-scoped awareness over the one `diffDocsBetween`, prefix-
  scoped unpushed/uncommitted/behind backstops, and `inTreeFetchAndRecord` — the fetch-and-report
  step session-start and `sync --pull-only` share. READ-SIDE ONLY: delivery is the user's own
  `git pull`; nothing here merges, rebases, pushes, or touches the working tree.
- **The diff family** (`src/diff.ts`): `diffDocsBetween` (the ONE ref-to-ref doc diff) and its
  two named projections, `changesSince` (the cursor feed) and `originDocsBetween` (the sync
  receipt's origin-side delta).
- **Error taxonomy** (`src/errors.ts`): `BoardGitError` + `classifyGitError` + the structural
  guard `isBoardGitError` (never bare `instanceof` — the dual-load hazard). The package's errors
  carry `code`/`details`/`help` ONLY; exit codes and envelopes are CLI boundary policy (the
  CLI `errors.ts`'s `cliErrorFromBoardGit`, the ONE mapping layer).
- **State store** (`src/cursor.ts`): `createSyncStore({stateDir, writeAtomic})` — the factory is
  the injection point; the CLI wires the default instance from its own credentials discipline
  (`~/.agentstate/sync`, `writeFileAtomic0600`). Plus the pure key/schema vocabulary
  (`bundleKey`, cursor/cache/marker types).
- **Neutral engine helpers** (`src/engine.ts`): `retargetBoardInterior`,
  `healStaleRebaseBeforeProvisioning`, `resolveBundleKey`, `toDeltaRows`, `singleActor`,
  `provisionAnnouncement`.
- **Flow steps** (`src/flow.ts`, carved in A1 from the CLI's `commands/sync*.ts`): the named
  sync/establish engine steps — ref/tree probes, git-dir crash markers, the committed-folder
  case's plumbing-only commits, the converge `annotateLanded` probe. Git/channel orchestration
  only, per the bar below; the establish/sync state machines themselves (refusal policy,
  previews, receipts) remain CLI command flows.
- **The autopull mechanic** (`src/autopull.ts`): the staleness-window trigger and the shared
  pull-and-record step, with the store and the bundle-root discovery INJECTED (`AutoPullDeps`);
  the trigger's call sites and the wiring of those seams stay in the CLI.

## What the package must NEVER export or import

- CLI invocations, help/usage text, rendering (TOON/JSON), environment resolution, exit
  behavior, or the CLI's `errors.ts`/`output.ts`/`invocation.ts`/`args.ts`.
- Command modules stay in the CLI as leaves consuming package APIs; the one legal reverse edge
  is the CLI's discovery layer consuming the package's `BUNDLE_DIR` constant.

## Completion criteria (from the plan's acceptance bar)

The extraction is complete only when: the package imports no CLI source and the
import-direction test (`test/import-direction.test.ts`, shipped with A1) has NO allowlist in any
merged commit; branch-mode behavior and output are pinned by parity tests; unknown remote state
cannot select or establish in-tree mode; in-tree v1 cannot push, create a board branch, or run
autopull; and the npm artifact still installs as one CLI.
