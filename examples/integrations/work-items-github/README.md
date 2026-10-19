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
built-in Task model. The example recipe is not a built-in or a maintained live provider profile.

## What the proof does

After installing this checkout's dependencies and building from the repository root:

```sh
npm run build
node --test --import ./packages/core/test/ts-loader.mjs packages/core/test/work-items-github.test.ts
```

`issues.json` contains six invented issues and one pull request, with schema provenance in the
file. No API response or private account data was captured. `profile.mjs` is an explicitly selected,
one-page **test double**, exporting a `SourceProfile` and scalar normalization function. It can
run through the existing public source harness; it is not the later first-party `github-issues`
extension and does not satisfy the complete provider-admission scenario matrix.

The acceptance test installs the real recipe, binds one repository, maps source-native and
normalized state, and sends changes through the real planner and guarded mutation engine.
New issues raise Signals; a sync never creates Work Items. A person adopts an issue by creating
a Work Item with its title and repository-scoped source identity. In the fixture, the next
observation fills empty owned fields in one write, preserves manual overrides with a conflict
Signal, and leaves the body and human-owned fields untouched.

The test's adoption/accepted-observation orchestration is deliberately local to the fixture.
It uses `changeBetween({}, mapped, ...)` for a newly bound document; there is currently no public
`adoptionChange` helper or production runner implementing that contract. The fixture remembers
accepted values for the feed/record/document tuple after applied, unchanged, converged and
partial-conflict outcomes. A refused, stale or uncertain whole step commits nothing. Resetting
this store and replaying a converged observation must still commit that baseline so the next
actual source edit does not falsely conflict. Do not reuse the fixture store as a durable runner.

Unknown native values keep the prior mapped field. Findings deduplicate per source, field,
diagnostic code and native value: an unknown closed reason affects both `state_category` and
`close_reason`, so it yields two field findings even if many records share that reason. Diagnostic
findings omit source titles and descriptions. Source text remains untrusted data.

## Scope and later increments

- This first Connector maps scalars. The convention declares labels/assignees/list types, but
  this mapping leaves those fields human-owned. Source-mapped lists are the separate G1b slice.
- Scalar `number` is kept on the source entry. No new tracker-specific Kind or claim mechanism
  is introduced. To assign bundle work, use a linked Task with a deterministic create-only id.
- The fixture accounts for every top-level field it presents, including explicit ignored fields;
  an unexplained field fails its coverage test. Navigation URLs are never followed. This coverage
  does not certify every current or future GitHub API field.
- Linear, synced relationships, real paging/cursors, disappearance scheduling, credentialed local
  runs and managed Connections remain separate work. A transfer is not an identity merge: the
  old and new repositories are different resources.
- Public author validation can correctly report `PROFILE_NOT_AVAILABLE` for `github-issues`
  until the first-party extension ships. Selecting this local fixture module explicitly for an
  offline test does not admit it to managed execution or turn it into a production integration.
