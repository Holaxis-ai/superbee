# Generic source profiles

Core owns `restJsonProfile`, its bounded Link parser (`nextLinkTarget`), and the source engine.
`getSourceProfile` and the inert `SOURCE_PROFILES` catalog contain only `rest-json`.

The public `SourcePluginHelpers` type describes contract-1 host composition for explicitly
trusted standalone adapters: `restJsonProfile`, `nextLinkTarget`, and `unsupportedContent`
(from `@superbee/core/source-engine`). `SOURCE_PLUGIN_CORE_VERSION` names the exact helper ABI.
These helpers are reuse, not an execution sandbox.

GitHub normalization, coverage, paging adaptation and provider tests live in the separately
installed `@superbee/integration-github` package. Core does not discover or import plugins.
