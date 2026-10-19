# Linear Work Item mapping fixture

This second-tracker example uses the same Work Item Kind as GitHub. Install `source-feeds`,
then `work-items`. That executable recipe installs the shared Kind and GitHub Connector.
The dedicated test explicitly creates the separate `connectors/linear.md` fixture declaration
through the document mutation primitive after parsing it against the installed Work Item Kind.
Linear is excluded from the default recipe until its provider profile is admitted, so public
`recipe validate examples/recipes/work-items` remains usable. No Work Items, credentials or
executing integrations are created by installation.

Linear is **fixture-only**. Its declaration has `auth: {kind: none}`, no domains, no request,
and an unavailable-by-default `linear-issues-fixture` profile. `profile.mjs` is a local projection
double over supplied records, opens no transport, and always reports a partial observation.
It is not an admitted provider profile. No GraphQL operation is executed here. A future credential
provider/read-scope policy and admitted GraphQL profile require separate implementation and review.

Run the owning acceptance test from the repository root after building:

```sh
node --test --import ./packages/core/test/ts-loader.mjs packages/core/test/work-items-linear.test.ts
```

## Provider evidence and identity

The fixture records selected official schema shapes with invented values, not account data or
captured API responses. Sources checked on 2026-10-19:

- [Linear's SDK schema, pinned at9dd2ed80](https://github.com/linear/linear/blob/9dd2ed80f93ae596f4f7fa21aa7cf80895c58514/packages/sdk/src/schema.graphql): `Issue`, `Team`, `WorkflowState`, `User`, `IssueLabel`, `Project`.
- [GraphQL getting started](https://linear.app/developers/graphql): team-scoped issues and archived pagination behavior.
- [Create issue URL forms](https://linear.app/developers/create-issues-using-linear-new): `linear.app/team/<team ID>/new` accepts team ids.
- [Profile](https://linear.app/docs/profile) and [SCIM](https://linear.app/docs/scim): nicknames can change; SCIM enforces unique nicknames.
- [Triage](https://linear.app/docs/triage): marking duplicate can result in a Canceled status.
- [Teams](https://linear.app/docs/teams) and [workspaces](https://linear.app/docs/workspaces): team identifiers and workspace domain keys can change.

The resource is `https://linear.app/team/{team}`, using the unique Team.id UUID, with Issue.id
as the external id. It uses the documented team-id URL namespace; it does not assert that this
resource itself is a navigable team landing page. Actual `Issue.url` remains the navigation link.
The unverified workspace/team browser-route candidate is not used. Mutable team key and issue
identifier remain display facts. A team move changes resource, even if the issue UUID survives:
there is no identity merge or automatic rebind. Fixture absence cannot prove disappearance.

The schema explicitly states `User.displayName` is unique within a workspace. We use
`linear:<displayName>` as the readable handle, matching the Work Item design; renames update it.
This does not assert global person identity across workspaces. The agent delegate stays a scalar
source property, distinct from human assignee. A future person model may use User.id.

## Mapping and deliberate loss

State type maps through the declared table: triage/backlog/unstarted → todo, started → in_progress,
completed → done, canceled/duplicate → canceled. Native `state.name` stays readable. The shared
model deliberately collapses triage and backlog in this mapping. Only an explicit duplicate type
produces duplicate close reason; a Canceled status named “Duplicate” alone is not sufficient.
Unknown state types keep the normalized category unobserved rather than inventing a category.

Labels flatten to `Group/Label`; assignee flattens to one prefixed handle or an empty list.
Priority0–4 maps to none/urgent/high/medium/low. Null estimate/date/terminal facts clear optional
fields; source body, human notes and tags are never imported. Explicit trash wins over archive
when determining source presence. Listing archives would require `includeArchived: true`; trash
visibility and complete enumeration are not established by this fixture.

Project is an optional single association on Issue in the official schema. This mapping retains
its id as a scalar source-entry property through the existing hook, alongside number, team_key,
estimate_scale and delegate id. This bounded consumer does not need Project documents or links,
so the evidence does not force a new Kind. Project lifecycle, cycles, milestones, parents,
duplicate relationships, attachments and code links remain L1b work. Label ids/colors, description,
previous identifiers and other selected relationship payloads are intentionally ignored. No Work
Item field or Kind was added for Linear.
