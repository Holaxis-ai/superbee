# Author and test an integration

A recipe carries definitions. Its Connector names a provider, permitted hosts, a source profile,
record identities and mappings into the recipe's Kinds. Installing it does not create a connection,
read a credential, fetch a provider or schedule a run.

Authoring and recorded tests need only the public CLI and core packages. No Holaxis account or
private repository is required. Live `source bind` / `source run` and managed execution are later
capabilities; the commands here do not enable either.

## Validate a recipe without executing it

```sh
superbee recipe validate ./my-recipe --json
superbee recipe validate ./my-recipe --readme --json
```

The validator uses core's recipe parser, Kind and Connector mapping checks, profile validation and
pin digest. It reports all Connector refusals with file locations and JSON pointers. Source summaries
name the shipped profile class, hosts, method, path and ownable fields. `--readme` includes a template
for the maintainer, compatibility, permissions, resource scope, support and test evidence; it does not
invent an official support commitment or managed admission.

Validation reads the selected local directory only. It never imports a module named by the recipe,
discovers a bundle, writes a document or makes a provider request. Unknown profiles are explicit
`PROFILE_NOT_AVAILABLE` refusals, not successful compatibility claims. For example, a declaration for
the future `github-issues` profile can be structurally sound while its runtime is unavailable in this
release. An explicitly selected test double does not change that fact.

The complete package is checked for core's secret-shaped text, including README files; `.env` and
`.env.*` containers are refused without opening them. Output names the offending location, never the
secret value. This is a packaging tripwire, not a guarantee that arbitrary secrets can be recognized.
Keep real credentials outside the recipe. Symlinks, special files, `.git`, malformed UTF-8 and inputs
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
and expected field values.

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

The Work Item example's `github-issues` module is a synthetic mapping test double. Passing its
mapping/adoption tests is not a full provider-profile qualification, live GitHub synchronization or
managed catalog admission. The production GitHub profile, local credential binding and managed
Connections retain their separate requirements.
