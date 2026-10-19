# Recorded REST integration authoring

This example uses a synthetic ticket board, not a live provider or a credential.

From a copy of this directory, using a CLI release that includes integration authoring:

```sh
superbee recipe validate ./recipe --readme --json
superbee source test ./recipe --fixture ./fixture --json
```

No checkout, account, environment variable or private source is required. The recorded fixture
exercises all required source scenarios, including hostile provider URLs. Expected values are
committed independently of the CLI run. Change one expected receipt or remove a required scenario:
the second command exits nonzero. Neither command writes to the recipe or a real bundle.

The Source Feed and Signal fixture conventions are the public source-feeds recipe definitions;
the Ticket example and recorded scenario corpus reuse the source engine's synthetic ticket board.
This tests the shipped declarative rest-json profile. It does not qualify a real provider, enable
local live execution, grant credentials or establish managed admission.

See `references/author-an-integration.md` in the CLI package (source:
`examples/references/author-an-integration.md`) for the fixture format and explicit local-code
execution boundary.
