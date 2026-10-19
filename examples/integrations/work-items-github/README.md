# Work Items: offline GitHub example

This example installs a reusable Work Item model and exercises synthetic GitHub issues through
the public Connector mapper and record-overlay write engine. It does **not** connect a GitHub
account, fetch a repository, schedule synchronization, or grant a recipe execution authority.

From this repository, install the definitions into a disposable OKF 0.2 bundle:

```sh
./superbee init --create-only --recipe none --dir /tmp/work-items-example/.superbee
./superbee recipe add examples/recipes/source-feeds --dir /tmp/work-items-example/.superbee
./superbee recipe add examples/recipes/work-items --dir /tmp/work-items-example/.superbee
```

Use a new disposable directory rather than an existing project. Installation creates one
Work Item convention and a Connector definition, not customer records. It preserves the simple
built-in Task model. The example recipe is not a built-in. It selects the first-party `github-issues` profile.

## What the proof does

After installing this checkout's dependencies and building from the repository root:

```sh
npm run build
node --test --import ./packages/core/test/ts-loader.mjs packages/integration-github/test/work-items-github.test.ts
```

`issues.json` contains six invented issues and one pull request, with schema provenance in the
file. No API response or private account data was captured. `profile.mjs` composes the separately installed
`@superbee/integration-github` factory with public Core helpers; it contains no separate implementation.
The Connector declares a repository GET request with Link-header paging and a complete all-state
listing. The public offline source harness runs that actual declaration against the recorded page.
A declaration supplies no credentials and does not authorize execution.

The acceptance test installs the real recipe, binds one repository, maps source-native and
normalized state, and sends changes through the real planner and guarded mutation engine.
New issues raise Signals; a sync never creates Work Items. A person adopts an issue by creating
a Work Item with its title and repository-scoped source identity. In the fixture, the next
observation fills empty owned fields in one write, preserves manual overrides with a conflict
Signal, and leaves the body and human-owned fields untouched.

The fixture and local `source run` use core's shared source-overlay adapter for adoption and
accepted observations. It tracks accepted values for each feed/resource/record/document tuple,
including applied, unchanged, converged and partial-conflict outcomes. A refused, stale or
uncertain whole step does not accept that candidate. Newly adopted documents are reconciled
against already observed records even when the provider has no new changes. The adapter stages
accepted values until the caller persists the matching source observation; the CLI owns the
private durable envelope, while the fixture uses an in-memory store. The offline fixture itself
does not establish live transport or credential handling.

Unknown native values keep the prior mapped field. Findings deduplicate per source, field,
diagnostic code and native value: an unknown closed reason affects both `state_category` and
`close_reason`, so it yields two field findings even if many records share that reason. Diagnostic
findings omit source titles and descriptions. Source text remains untrusted data.

## Scope and later increments

- The Connector maps labels and assignees as lists through the existing replace-all ownership
  engine. Lists write as sorted sets; a source reorder converges without a document write.
  Assignees carry `github:` before each login. Source-empty lists stay `[]`.
- A human-added label is retained with a conflict Signal when the source changes that list.
  Reopening and relabeling share one guarded write, including removal of closed-state fields.
- Scalar `number` is kept on the source entry. No new tracker-specific Kind or claim mechanism
  is introduced. To assign bundle work, use a linked Task with a deterministic create-only id.
- The fixture accounts for every top-level field it presents, including explicit ignored fields;
  an unexplained field fails its coverage test. Navigation URLs are never followed. This coverage
  does not certify every current or future GitHub API field.
- Linear, synced relationships, disappearance scheduling, credentialed local
  runs and managed Connections remain separate work. A transfer is not an identity merge: the
  old and new repositories are different resources.
- Public author validation uses inert metadata from an explicitly accepted local plugin registration.
  `source test` resolves its recorded scenarios through that same registered profile. The shipped
  partial author fixture reports its eight missing qualification scenarios honestly; full author
  qualification and live provider behavior remain separate evidence.
