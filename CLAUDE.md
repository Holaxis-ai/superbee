# Superbee — Orchestrator Guide

This file is read automatically at every session start. Superbee is an
**OKF-native, CLI-first, local-first** knowledge store: `packages/core` (the OKF
engine), `packages/board-git` (`@superbee/board-git` — the board's git channel:
porcelain/diff/state-store/engine/flow/autopull; imports ONLY node + core, machine-enforced by
its own import-direction test with no allowlist; command UX stays in the CLI),
`packages/server` (`@superbee/server`
— the wire-protocol REFERENCE server, a pure consumer of core; see gate 3 and Scope),
`packages/view-runtime` (`@superbee/view-runtime` — the private host-neutral launch and
trusted-action authority; imports only Node + core),
`packages/ui-server` (`@superbee/ui-server` — the private reusable loopback shell host;
imports only Node + core + server + view-runtime, while CLI policy and generated assets stay in
the CLI), `packages/markdown-renderer` (`@superbee/markdown-renderer` — the private shared
bounded Markdown-to-React security boundary), `packages/ui` (the browser SPA — PRIVATE workspace;
only its BUILT assets ship, gzip-embedded into the CLI bundle; it launches bundle-authored Views
and consumes markdown-renderer, see gate 4), `packages/mcp-app` (the PRIVATE local stdio adapter:
one fixed document-reader App plus one fixed active-View shell for registered or process-local
Views; the reader delegates to the shared renderer, and the View shell uses the same launch,
bridge, authorization, rendering, and governed-action authorities as the web host),
and `packages/cli` —
the **publishable npm package `superbee`** (the canonical bin is `superbee`; the legacy aliases `aslite` and `agentstate-lite` remain supported), an
esbuild bundle that inlines core + board-git + server + the built UI assets + deps into one
self-contained ESM file. The filesystem is the
DEFAULT local backend; the storage seam is pluggable (gate 3). Hosted deployment code is outside
this OSS repository; the former Cloudflare implementation is preserved only as a private frozen
reference.

Before changing anything, read the PROJECT BUNDLE — this repo's own knowledge bundle at
`.agentstate-lite/`, shared on a dedicated `board` branch via `superbee sync` (gitignored on
`main`, NOT committed with code). A fresh clone materializes it with one `sync` — the
SessionStart hook does a best-effort pull for you — after which the conventional-folder walk
discovers it with zero config, so a bare `doc read docs/core` just works: `docs/core` (the ONE-PAGE
product statement + frozen-scope list; scope questions answer to it), the board for live
state (`list --type Task`; per-unit records live in `tasks/<unit>` descriptions; the
pre-2026-07-06 changelog lives in the PRIVATE out-of-repo board archive, with the other
`visibility: private` docs), `docs/vision` (near-term design
intent + OKF grounding) and `docs/north-star` (the future-state vision) as needed — then
the packages' `src/`. The repo carries README + this file + code; the bundle rides the
`board` branch (root `/docs/` stays gitignored; `.superbee.json` and supported legacy
`.agentstate.json` bindings are also gitignored and must NOT be committed here — the conventional
folder is the resolution path). Ground
every change in the ACTUAL current code, not assumptions — including the claims in THIS
file: when this guide and the code disagree, the code wins and this file gets fixed.

## Standing gates (honor these before shipping)

### 1. AXI-conformance is a pre-ship check for the CLI

Any change to `packages/cli` must satisfy the ten AXI principles (see the `axi` skill).
Watch-points that are easy to regress here:

- **`read` truncates large bodies.** A `read` of a large document body must truncate and
  point at `doc read --out <file>` (the byte channel), never dump the whole body to
  stdout.
- **`list`/`query` default to a minimal schema.** Default output is a 3–4 field row
  (`id`, `type`, `title`, `timestamp`), with a `--fields` hatch for more — not the full
  frontmatter+body per row.
- **List output includes total counts.** `list`/`query` emit a `count`; `link show` emits
  `outbound_count` / `backlink_count`.
- **A `view`/detail shows backlink counts inline.** `link show` reports the derived
  "cited by" count next to the concept.
- **Errors go to stdout in structured form.** Error envelopes render as TOON on stdout with
  a capped exit-code taxonomy (0/1/2/4/5/6). Exceptions: `doc read --out -` routes the
  envelope to STDERR because stdout is reserved for raw bytes, and `mcp` routes every startup or
  runtime envelope to STDERR because stdout is the JSON-RPC transport.
- **Mutations are idempotent.** Re-writing a doc or re-adding an existing link must be a
  no-op that exits 0 (`link add` returns `changed:false` when the link already exists).
- **The SessionStart hook targets Claude Code, Codex, AND OpenCode.** `hook install` writes a
  REAL `session-start` hook to all three. A durable npm install binds the stable npm-prefix Node
  launcher and absolute package entry, so GUI hosts do not depend on their inherited `PATH`.
  Install/status/uninstall share one exact token-and-shape ownership classifier; familiar
  substrings or an OpenCode marker alone never authorize rewriting or deleting user config.

### 2. OKF-conformance for bundles

Every produced bundle must stay a valid OKF v0.1 or v0.2 Knowledge Bundle. Genuinely new bundles
default to v0.2 without asking users to choose an edition; `init --okf-version 0.1` remains the
explicit legacy-compatibility path. Existing bundles always retain their declared edition:

- Frontmatter on every non-reserved `.md`, with a **required, non-empty `type`**
  (OKF v0.1 §9; v0.2 §11).
- `index.md` / `log.md` are **reserved** at any directory level (§3.1); only the bundle-root
  `index.md` may carry frontmatter, solely to declare `okf_version`.
- **Cross-links are relative** bundle-relative markdown links (the form the reference graph
  builder counts as edges); core still resolves absolute `/…md` too, but the CLI **emits
  relative**.
- **Backlinks are derived**, never stored. **Freshness** is derived from the edition's meaningful
  change clock: v0.1 `timestamp`, or v0.2 `generated.at` when present. A v0.1 `timestamp` may arrive
  **unquoted** from external bundles, so it is normalized to an ISO string at the one parse layer.
  Do not reintroduce string-only timestamp guards upstream of that normalization.

### 3. Pluggable-core principle

- Storage lives behind the `StorageBackend` seam (`core/src/types.ts`); the filesystem is
  the **default** adapter (`FilesystemBackend` in `core/src/backend.ts`). Remote backends are
  plug-ins that implement the same interface — never baked into the engine. The
  engine keeps all OKF semantics; a backend only persists and retrieves. **`RemoteBackend`
  (`core/src/remote-backend.ts`) is the first remote adapter, proving the wire-protocol v0
  REFERENCE contract (`docs/WIRE-PROTOCOL.md`, `packages/server`). A concrete hosted deployment
  is deliberately outside this repository. The CLI is now `RemoteBackend`'s first REAL
  consumer** (`--remote <url>` on every bundle command, `packages/cli/src/bundle.ts`), not just a
  test-suite exerciser — so a wiring bug here is a user-facing bug, not a contract-test gap.
- **Flagship remote backend = document-centric** (per-doc identity, per-doc/namespace
  access, per-doc CAS concurrency), carrying canonical AgentState's proven versioning model:
  content-addressed snapshots + a head with a version + compare-and-swap writes + actor
  attribution. Git is an **export / interop + optional** adapter (OKF bundles are just
  files), **not** the flagship — it is repo-coarse for granular sharing and awkward for
  serving artifacts. Generated HTML is stored as a blob and served by content-type. See
  bundle doc `docs/north-star` and the versioning rationale it records.
- **The seam contract now carries the hard-case capabilities** (delivered in the
  "core-shape" pass): `read` returns a content-addressed (SHA-shaped) version token;
  `write` takes an optional compare-and-swap `expectedVersion` (throwing a typed
  `VersionConflict` on mismatch) plus an `actor`; `versions(id)` returns attributed history
  newest-first; and `readMany(ids)` batches reads so graph/backlink traversal is ONE
  round-trip, not N. `FilesystemBackend` is the **degenerate** adapter (version = SHA of the
  on-disk bytes, single-version `versions()` because a plain filesystem keeps no history).
  Its compare-and-swap is serialized per physical target **across same-user local processes** through
  a private external runtime lock; a process-local queue avoids needless polling. A crash leftover
  fails closed with inspectable owner metadata rather than being silently stolen. **`MemoryBackend`
  (`core/src/memory-backend.ts`) proves the same
  contract for the hard case** — a real version chain, enforced CAS, per-write attribution —
  and is the standing evidence that the engine leaks no filesystem assumptions (a
  dual-backend test asserts identical core-operation results over both). The seam is shaped
  for the hardest backend — networked, concurrent, multi-writer — so a document-centric (or
  git) remote adapter is a plug-in, not a rewrite.
- **The ENGINE API now surfaces those capabilities too** (delivered in the "engine-surface"
  pass): the seam no longer swallows version/CAS/actor/history. `writeDoc` takes an
  optional `WriteOptions` (compare-and-swap `expectedVersion` → typed `VersionConflict`, plus
  `actor`); `writeDocVersioned` returns the write's version token; `readDocVersioned` returns a
  document with its version; `docVersions(id)` exposes attributed history — all ADDITIVE, so the
  plain `writeDoc`/`readDoc` returns are unchanged and no version leaks into CLI (TOON) output.
  `link add` is the proof consumer: versioned read → append → CAS write with bounded conflict
  retry (preserving the idempotent `changed:false`). **Reserved files (`index.md`/`log.md`) are
  in the versioning/CAS model now**, not outside it: `readReserved` returns `{content, version}`,
  `writeReserved` honors CAS (FilesystemBackend cross-process lock + hash/rename; MemoryBackend
  in-memory enforcement). Portable-index projection preflights ownership across its whole target
  set, then uses each preflight read's exact version for single-shot per-file CAS; a conflict stops
  with completed/pending paths so a fresh run can resume without bypassing the global refusal. `log.md`
  remains an optional OKF reserved file carried by the generic seam and git sync; engine mutations
  do not automatically emit provenance entries into it.
- **Document mutation policy lives below the CLI** in core's `mutateDocument` service
  (`core/src/document-mutation.ts`). It owns create-only / overwrite / patch behavior, fresh
  read-decide-CAS-retry coupling, hard CAS, semantic no-op detection, timestamp-before-kind
  validation, actor propagation, and final-version receipts. Trusted consumers pass an already
  loaded kind registry and receive typed core failures. The CLI's `mutateDoc` is only an adapter for
  CLI error wording, remote hints, help text, and the best-effort board-attribution hook. Do not
  duplicate this policy in a future UI or server action path.
- Keep exactly **ONE** frontmatter parser, **ONE** bundle walk, **ONE** link resolver, and
  **ONE** View semantics/action authority. Human-facing hosts are adapters over those authorities:
  the supported local `ui` shell launches durable bundle-authored Views; the local `mcp` command
  displays authoritative documents in a fixed reader or launches process-local/registered active
  Views. Do not reintroduce a parallel Markdown parser or mutation policy inside either host: the
  MCP reader delegates to the shared bounded renderer, while both View hosts delegate the same
  `document.set-field` proposal to view-runtime, which requires trusted-shell confirmation and hard
  CAS through core's mutation service; MCP keeps its prepare/finish tools app-only so the model and
  sandboxed View cannot invoke writes directly.
- **Kind conventions (`core/src/kinds.ts`) are ONE registry, in core, consumed everywhere —
  not a schema fork.** A bundle MAY declare document kinds as plain OKF convention docs
  (`type: Convention`) naming the `type` value they govern, its required/optional fields,
  allowed enum values, expected body sections, and a freshness horizon. **THE MECHANISM IS
  CORE AND NON-NEGOTIABLE; USAGE IS OPT-IN PER BUNDLE**: a conventions-free bundle (every
  external OKF bundle today) behaves byte-for-byte as before. **The discovery contract is
  prefix-scoped and documented, not incidental:** a kind convention doc MUST live under the
  `conventions/` prefix to be discovered (`loadKinds` calls `query(bundle, { prefix:
  "conventions/", type: "Convention" })`) — a `Convention` doc anywhere else is silently
  NOT a kind, by design, and this is what keeps a conventions-free bundle's registry load a
  cheap list-of-nothing. Malformed conventions are skipped with a collected warning, never
  thrown; a duplicate `governs` keeps the first-by-id declaration. The registry is built
  ONCE per invocation, in the COMMAND layer (`kinds`/`new`/`doc write`/`doc update`/`list`'s
  kind columns, and the other kind-aware commands — `status`, `link`, `home`, `promote`,
  recipe/init seeding); no engine path (`readDoc`/`writeDoc`/…) loads it
  implicitly. `validateAgainstKind` returns core's existing `ValidationWarning` shape and
  reuses THE one heading splitter (`splitSections`, now in `kinds.ts`) for section linting —
  no second heading parser. `freshnessHorizonMs` FEEDS the existing
  `FreshnessOptions.maxAgeMs`; it does not fork `freshness()`. **Seeding is a CLI RECIPE
  concern, never an engine one** (the recipe-zero + pluggable-recipes passes): `initBundle`
  seeds NOTHING (core carries zero convention content — the former `note` command and its
  core codec are deleted; context notes are a plain default recipe authored via the generic
  path); the CLI's `init` applies the built-in `context-notes` recipe (`--recipe none` opts
  out), `recipe add` installs others (e.g. `work-tracking`), and every recipe — built-in or
  external folder — flows through ONE `RecipeSource`/`parseRecipeFiles` pipeline applying
  via expect-absent CAS (idempotent, never clobbers a hand-edited convention). If a future
  consumer (server/an MCP surface) needs kind awareness, it calls `loadKinds` itself
  — do not thread a second registry implementation through a different layer.

### 4. Human visibility — one View model, host-specific adapters

The human-visibility surface is the **local `superbee ui` command**: one loopback
server serving the embedded SPA over a bundle (`--dir` mounts the reference router
in-process; `--remote` reverse-proxies with the stored key; per-run token + Host allowlist
+ CSP). `superbee doc open <id>` is its thin exact-document entrypoint: it verifies the document,
opens the existing DocPage route, and adds no renderer or static export path. The shell is a
launcher for registered `type: View` docs rendered in sandboxed
iframes (`Page` is the legacy kind name and `bridge` the legacy access-field spelling — both are
RETIRED: a legacy Page-typed doc no longer registers and a legacy bridge-only doc resolves to
`access: none`; `scripts/migrate-legacy-view-names.mjs` renames legacy content in place and
`status`'s legacy_naming finding is the loud diagnostic for leftover stock. Old folder LOCATIONS
stay recognized — relocation is a separate open decision); Views are bundle content, and their live data
access goes through one server-owned, launch-bound bridge. Active Views that request bundle data
are mounted only after trusted shell chrome approves their exact HTML bytes and declared access;
the CLI remembers that approval locally (never in the synced bundle), and changed bytes or
expanded access ask again. Approval treats those exact bytes as trusted executable code with the
declared bundle authority; sandboxing and CSP remain defense-in-depth, not a substitute for
trusting the View's source. Bridge authority is revalidated before and after each request. V0 data
access remains read-only; a local `--dir` View may
opt into `bundle-propose` for one human-confirmed, version-guarded scalar-field action. The former
`packages/viewer` / `view` → `viz.html` surface is removed — author human
views as bundle Views rather than adding a second rendering engine.

The local `superbee mcp` command is a second host adapter, not a second View system. Its
default bundle-unbound mode exposes the user's private catalog through `list_workspaces`; its
read-only `show_document` and `list_views` root tools require one exact catalog label or ID and
never accept a filesystem path. Explicit `mcp --dir <bundle>` retains the fixed-bundle
compatibility/developer mode. Bundle-selected executable View launch routing is not yet exposed by
the unbound mode; fixed mode remains the authority for `show_view` and its hidden lifecycle until
that routing is launch-bound. Its
model-visible `show_document` tool presents one exact authoritative bundle document in a fixed,
non-executable reader through the shared bounded Markdown renderer; its compact model result
carries only a one-shot claim, and the App retrieves the rendered payload through an app-only
resolver. The separate model-visible `show_view` tool launches either agent-authored active HTML
as a process-local transient View or one existing registered View unchanged by exact id. Both use the
same active source contract, launch/bridge authority, sandbox, CSP, shared bounded Markdown
renderer, subscription and sizing behavior, and require exact-byte local trust approval before
bundle data is exposed. Transient approval is process-local and never enters the persistent
registered-View trust store. The model-visible `save_transient_view` tool can persist an approved
launch unchanged as a registered View; it accepts no HTML, and the new durable identity requires
its own local approval. App-only lifecycle and prepare/finish tools remain hidden from the model;
actions require a configured actor, explicit human confirmation, version revalidation, and hard
CAS through the shared action and mutation authorities. The adapter is deliberately local,
stdio-only, and shipped inside the supported npm CLI rather than as a standalone package.
`superbee mcp status` is a separate read-only host-registration inspector: it checks only the
bounded user-level surfaces for Codex/ChatGPT, Claude Code, Claude Desktop, and OpenCode, never
opens or selects a bundle, and has no install/uninstall authority.

The multi-human collaboration substrate (hosted worker, auth, admin) is FROZEN per bundle doc
`docs/core` and preserved outside the OSS repository — it is not a build or deployment target
without an explicit human decision.

### 5. Local-first, standards-clean

Local-first: everything works with the network off. No bundled secret; credentials (if
any) live in `~/.agentstate/` with 0600/0700 discipline and are never printed. Stay
standards-clean (plain OKF markdown; no bespoke schema). Link form is **relative
bundle-relative**.

## Working here

### Engineering discipline

- Keep each PR to one coherent behavioral or policy claim. If its correctness depends on a
  second decision, split it or make that decision explicit before implementation.
- Keep source comments short. Explain only stable, non-obvious reasons; review-round history and
  adjudication narrative belong in the PR or project bundle, not beside the code.
- Treat words such as **canonical**, **parity**, and **gate** as testable claims. Use them only when
  the implementation or an executable check directly proves the stated relationship.
- When one behavioral contract has multiple public surfaces, exercise every surface from one
  per-row agreement table. Prefer one owning primitive when the behavior can be collapsed;
  agreement tests pin irreducible projections and boundaries, not duplicated implementations.
- Add deterministic adversarial tests for dangerous boundaries, including concurrency,
  authentication, migration, reconnect/replay, and destructive writes.
- Consolidation removes the superseded implementation, tests, and commentary in the same unit;
  do not leave two paths with a comment declaring which one should win.
- A recurring bug class is API-design feedback. Move the invariant into one owning primitive so
  callers cannot reproduce the mistake; do not keep patching consumers or adding reminders.
- Keep verification output out of agent context. Run `npm run check`, workspace-wide tests,
  browser/E2E suites, mutation tests, and other full-repository gates with complete output
  redirected to a temporary log. On success, inspect nothing further; on failure, inspect only
  failure matches and a bounded tail. Inspect summaries before potentially large diffs or searches.
  When uncertain, capture output instead of streaming it.

- Build/verify gate: `npm run build` and `npm run typecheck` must exit 0, and `npm test`
  (`--workspaces --if-present`: board-git + core + cli + server + ui suites) must pass, before
  shipping. `npm run check` runs all of that plus this repo's own `scripts/` tests (`test:scripts`),
  the installed-tarball proof (`verify:npm-package`), and the npm-target SKILL.md drift gate
  (`check:skill`) in one shot. npm is the sole executable distribution authority: the package
  ships the CLI plus a generated, optional Agent Skill containing guidance and references only.
  **Always build from the REPO ROOT** — a package-scoped build leaves sibling `dist/`s stale and
  test files that import them crash confusingly. `npm run build` bundles the CLI to
  `packages/cli/dist/superbee.mjs` (esbuild). Invoke the freshly-built CLI in-repo via the
  repo-root **`./superbee`** shim (`./superbee doc write …`) — a short, shell-agnostic wrapper over that
  dist; prefer it over the long `node packages/cli/dist/…` path and never alias the path into a shell
  variable (`B="node …"; $B …` breaks under zsh, which does not word-split). The shim is dev-only and
  never ships (`files: ["dist"]`). Smoke-test the built CLI — at minimum `init`, `doc write`/`doc read`,
  `list`, `link add`/`show`, and `status` on `examples/sample-bundle`. Run
  `npm run verify:npm-package` to prove the exact tarball allowlist, zero-runtime-dependency
  boundary, both command names on an isolated `PATH`, the absence of the retired marketplace
  executable roots, and an offline create/query workflow. The developer gate builds an honestly labeled
  `local-dev` tarball so it remains runnable on an in-progress/dirty checkout. `prepublishOnly`
  runs the same journey in strict `npm-package` mode and refuses unless Git proves an exact clean
  source commit.
- **Mutation testing measures the SUITE, on demand — never a merge gate.** `npm run
  mutation:core` / `mutation:cli` run Stryker (tap-runner over the repo's own `node --test`
  ts-loader invocation; `inPlace`, so run them in a clean tree — a crash restores from
  `.stryker-tmp`, or `git checkout` recovers) against `packages/{core,cli}/src`; build from the
  repo root FIRST (core's tests import sibling dists; cli's config rebuilds its bundle once,
  post-instrumentation, via `buildCommand`). CI runs both weekly and by dispatch
  (`.github/workflows/mutation-tests.yml`), publishing the survivor list — the suite's named
  gaps — to the job summary (`npm run mutation:survivors` locally); file recurring survivors as
  board tasks rather than chasing a score.
- **Verify a gate by its own exit code, never through a pipe.** A piped tail or grep (`npm test |
  tail`, `... | grep -v Skip`) reports the PIPE's last command's exit status, not the gate's — a
  failing gate can read as green. Run gates unpiped, or redirect to a file and grep the file
  separately; check the exit code from the LAST change made, never a stale run from before it.
- A fresh git worktree has no node_modules: run `npm ci` inside it before trusting any
  test or drift-gate result (up-tree module resolution manufactures phantom failures).
- `examples/sample-bundle` is the interop fixture: externally-shaped (unquoted timestamps,
  relative links, wrapped bullets). If a change breaks its round-trip, the change is wrong.
- **Operator receipt emission is non-clobbering and release-ID bound.**
  `scripts/release-inspect.mjs` completely inventories the draft by numeric release ID, binds the
  retained `candidate.json`, and treats one valid current receipt as `already_present`. A missing
  receipt uses a private journaled no-clobber upload. Re-emission is destructive only when the
  operator supplies the old receipt's exact ID, name, and digest (row-local `replace_existing` in
  batch mode); interruption recovery resumes the one journaled signed digest and never deletes a
  competing same-name asset. `--dry-run` signs and validates the same plan without durable owner,
  journal, DELETE, or upload writes.
- **Branch from CURRENT `origin/main`, never from a previous PR's tip.** The npm-target
  `packages/cli/SKILL.md` (`check:skill`) is still generated from `reference.ts` and PR-verified, so
  a branch cut from a stale tip can carry a stale version of it relative to current main. More
  generally, regenerated prose can go semantically stale without any drift gate catching it — a
  change can make a sentence FALSE without any generator noticing. After any merge into a branch,
  re-read the regenerated prose near your change and check the front-door docs (README quickstart)
  still tell the truth.
- Commit cadence: one commit per reviewed unit of work, with a descriptive message; push to
  the private implementation remote until public cutover approval. The
  pre-public development history lives on the local `archive/pre-public` branch — NEVER push
  it (it predates the open-source scrub).
- **Review and QA are risk-tiered by change-type, and standing gates absorb review work.**
  Every PR remains one coherent claim and must pass the relevant automated and pre-ship gates
  above. Assurance effort tracks RESIDUAL risk — the risk left after the machine gates (CI on
  every PR, drift gates, import-direction tests, parity/agreement suites, mutation runs) have
  had their say. Apply judgment to the whole change and its consequences, not its label:
  - Trivial docs, metadata, dependency, or test-only corrections with no runtime-behavior or
    consequential-mechanism change may ship after author validation and the relevant automated
    checks; independent review and dedicated QA are not mandatory.
  - Behavior-preserving changes carrying a MECHANICAL parity contract (pre-change rendered-byte
    fixtures, byte-parity transcript batteries, agreement suites): Builder → ONE independent
    review whose center of gravity is the CONTRACT'S PROVENANCE — prove the fixtures/battery
    derive from the pre-change code, spot-re-run a sample, probe the contract red once. No
    separate QA stage unless that review finds drift or the contract cannot cover a reachable
    state. Do not build a second from-scratch verification battery to re-prove what the
    contract already pins.
  - Ordinary code changes require independent review of the exact SHA plus the repository gate;
    dedicated QA is optional based on the change's risk and the review findings.
  - New or changed MECHANICS on high-risk boundaries — security/auth, concurrency, destructive
    writes, migrations/deployments, remote-target selection, reconnect/replay — require
    Builder → independent review → adversarial QA, with QA aimed at what no gate can reach
    (true multi-process concurrency, interruption, states nobody enumerated).
  - Do not game a lower tier by splitting or relabeling a consequential change. A reviewer may
    escalate the tier when evidence or findings justify it — and may recommend de-escalation
    with the reasoning stated, which the orchestrating session decides.
- **The ladder is subject to its own epistemics.** Per-unit board records carry findings per
  review/QA stage. When a stage's find-rate is zero across consecutive units of the same
  change-type, that is evidence the stage is redundant with the standing gates for that
  change-type — retire or thin it there deliberately (a recorded decision, not silent decay).
  A stage that keeps finding real defects keeps its place. Words like "verified" and "proven"
  remain testable claims at every stage.
- **When independent review or QA is required, use these review-process conventions:**
  - Agents that touch git or run tests work in an ISOLATED worktree/checkout, never the
    shared working tree; reviewers detach onto the exact sha under review.
  - A risky mechanic and the test that makes it safe ship in the SAME reviewed unit —
    a gate must own the risk it guards.
  - A review claiming it "executed" a documented command chain means character-for-character
    with the emitted artifacts — no reasonable substitutions; pin such chains with tests that
    literally run the emitted strings.
  - Reviewers verify empirically where feasible (built artifact, scratch environments),
    label each finding empirical vs reasoned, and report survived attacks alongside
    findings so an APPROVE is calibrated.
  - Reviewers AUDIT the builder's verification rather than rebuilding it: check its
    construction, re-run a sampled subset, and probe it red once — a full independent
    re-verification is reserved for provenance checks and for evidence of drift. Where CI
    already ran the repository gate on the exact SHA, cite that run instead of re-running the
    full gate locally; re-run locally only what the review has reason to distrust.
- **Security disclosure:** a defect that is (a) exploitable by someone other than the
  victim AND (b) present on main goes through a private GitHub Security Advisory —
  fix privately, merge, then disclose — never a public PR comment or board doc.
  Pre-merge review findings stay public by default. The board is public: the
  write-time scrub discipline covers vulnerability details, not just secrets.
- **Records live on the PROJECT BUNDLE (the in-repo board at `.agentstate-lite/`) — the
  product tracks its own build.** Unit-close means: update `tasks/<unit>` (bare
  `doc update tasks/<unit> --progress_status …`, with the description carrying the record — what shipped, commit hash,
  honest caveats) and, when the shipped list or sequence changed, the bundle's `roadmap`
  doc. Plans are authored as bundle docs (`plans/<unit>`, `type: Plan`); research as
  `research/<topic>` (`type: Research`). Byte-channel moves (files ↔ bundle) go through
  `promote`/`pull`, never model retyping. Stale records have real cost here (a session once
  nearly rebuilt a shipped unit), so: BEFORE building any "queued" item, grep the tree —
  records may lag the code. Work is CLAIMED before it is built: flip `tasks/<unit>` to
  `in_progress` with `--actor` — the CAS write IS the claim (see the bundle's Task convention).
  **Board writes are not code commits.** Board/bundle writes (records, claims, context
  notes, task updates — anything under `.agentstate-lite/` with no code alongside) go through
  `superbee sync`, which shares them on the repo's own `board` branch. The board was MIGRATED off
  `main` (it is gitignored there now), so there is no longer a `board:`-prefixed direct-commit-to-main
  path — `sync` is the one channel, and it touches nothing outside the board. Code ships via branch +
  PR + review gates, always. A board doc rides a PR only when it is ITSELF the reviewed
  deliverable (a plan under vetting, records that explain a code change they accompany).

## Scope

**This section states what EXISTS and what is GATED — the authoritative, per-unit current-state
record is the PROJECT BUNDLE (board task descriptions + the `roadmap` doc; the frozen pre-shrink
changelog is bundle doc `archive/status`), and the forward sequence is `roadmap` plus
bundle doc `docs/north-star`. Do not grow a second changelog here: an earlier revision of this section
accreted per-unit history, fell out of sync with the moving tree, and became the most-misleading
file in the repo (a coherence audit's top finding). Keep it SHORT and re-verify claims against
the code when touching it.**

What exists, end to end (each verified in production or by the full suite — per-unit records on
the bundle):

- **Stage 1 wire CLOSED.** The wire protocol (v0.1: docs + reserved files + blobs + delete +
  push-down list) is implemented by the reference server (`packages/server`, loopback/no-auth by
  design). The former Cloudflare Worker + D1/R2 + hosted-auth implementation has been extracted
  from OSS and preserved as a private frozen reference; no hosted deployment package is built or
  maintained here.
- **Three backends, one contract:** Filesystem (degenerate history; CAS serialized per target
  across same-user local processes with fail-closed crash-leftover recovery),
  Memory (enforced), and Remote (wire client, typed `RemoteError` with server-derived codes).
  Tri-backend parity tests pin byte-identical version tokens.
- **Explicit `--remote <url>` on every bundle command** is the only HTTP activation path; `serve` boots the
  reference server locally; `promote`/`pull`/`blobs`/`delete` are the byte channel. Known
  divergence (recorded in `docs/WIRE-PROTOCOL.md` open questions): a concept doc's RAW bytes
  don't cross the wire — `doc read --out --remote` re-serializes via `stringifyDoc` (canonical
  form; byte-identical only for engine-written docs).
- **Kinds + recipes:** kind conventions (gate 3) with three built-in recipes (`context-notes` —
  init's default — `work-tracking`, the Task kind the team's own board runs on, and `roadmap`)
  over one pluggable `RecipeSource` pipeline.
- **Scans are cheap end to end:** `list`/`query` ride head projections (`queryHeads`) so a
  capable remote can return frontmatter without transferring document bodies.
- **The local `ui` command + bundle Views** (gate 4): the SPA-over-loopback launcher is shipped
  and working in both modes; registered Views are the one human-facing rendering primitive. The
  bundle now also holds the project's own plans/research/changelog-archive docs — the records
  convention above.
- **The `sync` verb (git tier)** — shares a project's board over a `board` branch on the
  repo's own remote: self-healing provisioning (sync is the SETUP verb on a fresh clone of a
  board-sharing project), commit/pull/push touching nothing outside the board, CONVERGING
  conflict resolution (teammate's version kept, yours exported to a file; reconcile via
  `doc update`, exit 5), `--show-incoming <id>` viewer, `--pull-only`, cursor + awareness
  cache (`packages/board-git` is the channel mechanics; the CLI's `commands/sync*.ts` +
  `cursor.ts`/`autopull.ts` wiring keep command UX — core never
  learns git exists), and the SessionStart integration: `session-start` — ONE hook
  subcommand doing a time-boxed (≤7s) best-effort pull then the home render in-process, with
  the board-awareness block ("since this machine last synced" attributed per actor,
  self-authored rows filtered, unpushed/uncommitted backstop, probe-gated "run sync — never
  init" first contact), wired by `hook install` across Claude Code/Codex/OpenCode
  (`commands/session-start.ts`, `commands/home.ts`'s board block, `commands/hook.ts`).
  An IN-TREE board — the bundle committed WITH code on the current branch, no board branch
  anywhere — is a supported READ-SIDE mode: `detectBoardChannel` routes at
  sync's/session-start's own resolution points, awareness rides the branch's tracking upstream
  (decision table, never a guessed `origin/<branch>`; mode-scoped `git-intree` cursor;
  prefix-scoped diffs/backstops; NO autopull), delivery is the user's own `git pull`, write
  verbs refuse with guidance, and doc-write self-attribution rides mutate.ts's injected
  post-persist hook (`board-attribution.ts`).

Standing gates on future work:

- **Hosted revival is human-gated.** This repository carries no Cloudflare deployment target.
  The frozen private reference records that any future revival must review the architecture and
  apply D1 migrations before deploying dependent code.
- **The npm prerelease is the executable distribution channel.** `superbee` ships the
  self-contained CLI plus an optional installable Agent Skill containing guidance and references;
  keep `npm run verify:npm-package` and the npm-target SKILL drift gate green. Automated publishing
  and the durable update-notification contract remain separate explicit units.
- **Multi-bundle partitioning + per-bundle key scoping + bundle-scoped authz** is its own
  future unit, designed and built TOGETHER (the Stage-2 review's adjudication) — do not build
  piecemeal, and do not build without an explicit decision. Same for the GitHub device-flow
  browser login, any admin/collaboration UI, and everything on bundle doc `docs/core`'s FROZEN list —
  CORE.md is the standing scope arbiter.
