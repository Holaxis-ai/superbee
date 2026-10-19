# Author and test an integration

A recipe carries definitions. Its Connector names a provider, permitted hosts, a source profile,
record identities and mappings into the recipe's Kinds. Installing it does not create a connection,
read a credential, fetch a provider or schedule a run.

Authoring and recorded tests need only the public CLI and core packages. No Holaxis account or
private repository is required. Local `source bind` / `source run` use explicit private consent;
managed execution remains separate. Recorded tests never enable live execution.

## Validate a recipe without executing it

```sh
superbee recipe validate ./my-recipe --json
superbee recipe validate ./my-recipe --readme --json
```

The validator uses core's recipe parser, Kind and Connector mapping checks, profile validation and
pin digest. It reports all Connector refusals with file locations and JSON pointers. Source summaries
name the available profile class, hosts, method, path and ownable fields. `--readme` includes a template
for the maintainer, compatibility, permissions, resource scope, support and test evidence; it does not
invent an official support commitment or managed admission.

Validation reads the selected recipe directory and inert accepted plugin metadata. It never imports a module named by the recipe,
discovers a bundle, writes a document or makes a provider request. Unknown profiles are explicit
`PROFILE_NOT_AVAILABLE` refusals, not successful compatibility claims. Core supplies `rest-json`; `github-issues` requires explicit registration of the independently installed GitHub plugin. Registered plugin spec checks are deferred to source test/bind/run; validation never imports its module.
An explicitly selected test double does not establish compatibility for an unavailable profile.

The complete package is checked for core's secret-shaped text, including README files; `.env` and
`.env.*` containers are refused without opening them. Output names the offending location, never the
secret value. This is a packaging tripwire, not a guarantee that arbitrary secrets can be recognized.
Keep real credentials outside the recipe. Dot-prefixed entries are refused before traversal or
opening, matching recipe acquisition. Symlinks, special files, malformed UTF-8 and inputs
beyond the documented bounds are refused. Bounds are 512 directory entries, nesting depth 12,
2 MiB per file and 8 MiB total. Select the recipe subdirectory rather than an entire repository.

## Replay recorded source responses

The distributed `references/integrations/rest-json-authoring/` example includes a recipe and a
passing recorded fixture for every required scenario. Copy that directory somewhere outside the
source checkout and run the two commands in its README. It needs no `--profile` executable module.

```sh
superbee source test ./my-recipe --fixture ./fixtures/my-source --json
```

The fixture directory contains `fixture.json`. The selected Connector and source must belong to the
recipe. Core's public source harness runs every scenario through the same observation engine,
mapping, record-overlay, conflict rules and in-memory storage that library consumers use. The CLI
does not have its own observer or mapper, and it opens no live transport.

The version-1 JSON shape is:

```json
{
  "version": 1,
  "connector": "connectors/example",
  "source": "items",
  "feed": "source-feeds/example",
  "documents": [],
  "scenarios": [
    {
      "name": "errors.server",
      "runs": [{"exchanges": [{"request": {"url": "https://api.example.org/items"}, "response": {"status": 503}}]}],
      "expect": [{
        "receipt": {"outcome": "provider_unavailable", "reason": null, "pages": 0, "held": 0, "pending": 0, "pass": {}, "changes": {}},
        "cursor": null,
        "requests": [],
        "changes": [],
        "findings": []
      }]
    }
  ]
}
```

This illustrates the shape, **not passing expected values**. Populate `documents` with the Source
Feed, its necessary conventions and any existing target documents; recipe conventions are already
included and cannot be shadowed. Supply the real expected receipt fields, requests, cursor, changes
and findings for every run. A recipe's definitions-only directory and recorded fixtures remain
separate. Expected values are compared exactly; missing expectation keys, changed receipts, unused
recorded exchanges, unscripted requests and failed core invariants fail the command.

Each exchange records the method and URL expected by the public harness and a response (`status`,
optional headers and body), `{ "fail": true }`, or `{ "hang": true }`. Runs may specify `mode`, `at`,
`edits` and a bounded engine `budget`. Fixture records can include hostile URLs and other attack
strings to test refusal. The report never echoes provider payloads, profile exception text or actual
and expected field values. Echoed scenario names must not contain secret-shaped text; invalid
presentation metadata is refused without printing its value even when attack payloads are allowed.

The report lists required and missing scenarios. Cover authentication/rate/server/malformed errors,
incomplete pages, cursor resume and hostile cursors, complete-observation disappearance, owned-field
conflicts, unmapped and null values, missing identity, redirects and undeclared hosts. A subset may
be useful during development, but missing required scenarios always makes the final command fail.
Scenarios are bounded to 64, with at most 16 runs per scenario and 512 exchanges per run.

## Explicitly test local profile code

```sh
superbee source test ./my-recipe --fixture ./fixtures/my-source --profile ./profile.mjs --json
```

`--profile` deliberately imports local JavaScript. Its default export (or named `profile`) must be a
public `SourceProfile` with the same id as the declaration. The fixture may supply `spec`; otherwise
the profile receives the parsed Connector source. A scenario can override its spec to exercise
refusal cases. Core's `SourceProfile`, `runSourceScenario`, `runSourceFixture` and conformance tools
are also available directly from `@superbee/core/source-engine` and `/source-harness` in `node:test`.

**Run only code you trust.** A local extension runs in this Node process with its ordinary authority;
this is not a sandbox, and using a recorded transport does not prevent arbitrary code from using
ambient APIs. The static egress check and independent admission review lower that risk; they do not
provide isolation. Neither a fixture nor a recipe can implicitly select a module for the CLI to
execute. Validation and installation never import one.

The public [superbee-plugins repository](https://github.com/Holaxis-ai/superbee-plugins) owns the
[GitHub integration](https://github.com/Holaxis-ai/superbee-plugins/tree/main/integrations/github),
[Work Item recipes](https://github.com/Holaxis-ai/superbee-plugins/tree/main/recipes) and
[GitHub/Linear examples](https://github.com/Holaxis-ai/superbee-plugins/tree/main/examples). Its synthetic fixtures
qualify mapping and observation behavior; live provider access and managed catalog admission remain
separate evidence.

## Register the GitHub integration from a source checkout

The GitHub integration is distributed through the public Git repository; no integration npm
publication is required. Follow the repository README's
[install from source](https://github.com/Holaxis-ai/superbee-plugins#install-the-github-integration-from-source)
steps: select and review a full 40-character Git commit, check it out detached, install development
tools and the exact compatible public Core version, then build. Review code before running its
installation or build commands. Core and the Superbee CLI retain their normal npm distribution
channels; this source checkout supplies the integration code.

With that built checkout at `./superbee-plugins`, select its integration directory explicitly:

```sh
superbee source plugin register ./superbee-plugins/integrations/github --json
superbee source plugin register ./superbee-plugins/integrations/github --accept <digest-from-preview> --json
superbee source plugin list --json
superbee recipe add github:source-feeds --dir ./bundle
superbee recipe add github:work-items --dir ./bundle
```

Registration copies a bounded manifest, standalone module and inert recipe bytes into private
immutable generations. Preview, acceptance, listing, removal and recipe installation never import
plugin code. Acceptance trusts those local bytes as reviewed code executing with ambient process
authority. A package name and digest do not authenticate publisher origin or provide a sandbox.
A full Git commit identifies the selected source; it does not authenticate the publisher or make
that code safe. Superbee does not acquire or build integrations. Registration grants no feed binding
or credentials. Use the checkout's `recipes/source-feeds` and `recipes/work-items` folders for
`recipe validate` and its recorded fixtures for `source test`, following the repository examples.

Updates require reviewing another full Git commit, checking it out and rebuilding with the README's
compatible Core setup, then a new accepted registration and explicit feed rebind.
Rebinding changed consent resets observations and accepted tuples for reacquisition. Remove future
availability with `superbee source plugin remove github`; already selected runs may finish their
selected generation. Existing bundle content and retained generations are preserved.

## Bind and run a local Source Feed

After installing a recipe and creating its Source Feed in a local or Git bundle, preview consent:

```sh
superbee source bind source-feeds/github --anonymous --dir ./bundle --json
superbee source bind source-feeds/github --anonymous --accept <digest-from-preview> --dir ./bundle --json
superbee source run source-feeds/github --dir ./bundle --json
```

Binding previews make no provider request and read no credential. Acceptance pins the physical
bundle, feed, declaration/provider rules, resource, Kind/overlay policy, profile/version and accepted implementation identity
and budgets in private user state. A changed pin refuses before module import, factory/spec execution, network or credential reads;
preview and accept again. Copying or moving a bundle requires a new binding. `--complete` requests
a complete pass; an interrupted pass never claims completeness.

Anonymous public GitHub reads use the same read-path/resource guard and never discover credentials.
For an explicitly authorized credentialed run, replace `--anonymous` with `--credential-env NAME`;
the binding stores only that variable name. Supply the token separately through the process
environment. Never put token values in arguments, recipes, fixtures or documents. GitHub token and
GitHub App installation-token declarations are supported; no login, token exchange or credential
discovery is performed. A 401/403 is a normal credential-refused result.

Run admits built-ins and explicitly registered plugins and uses bounded DNS-pinned HTTPS. It updates existing documents
linked by `sources` and existing overlay Signals; it does not create mirrored Work Items. A document
linked after a prior observation can adopt cached last-observed values on its next run, including a
304. A held invalid provider value needs a fresh observation; it is not retained as a retry queue.
Private observation/accepted state persists with one lock and atomic envelope. A crash after a
bundle write can replay through the same conflict rules; no exactly-once cross-store transaction
is claimed. Corrupt private state refuses without reset. Summaries omit records, cursor, raw
provider errors and credential values. Neither bind nor run synchronizes or publishes a bundle.

Run receipts include fixed machine reason codes where available, never provider error text.
A terminal unsuccessful run exits nonzero after its receipt: credential refusal 4, not found 6,
guard/content/size refusal 2, and provider/runtime failure 1. Observed and deferred exit 0;
deferred retains retry metadata for continuation and does not claim a complete observation.
