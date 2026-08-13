# `@superbee/ui-server`

Private workspace package for the loopback HTTP runtime behind `superbee ui`.

It owns the reusable listener, session checks, reverse proxy, View nonce/CSP handling, SSE hub,
and bundle watcher. Consumers inject their asset table and bundle-display-name policy. The package
may depend only on Node built-ins, `@superbee/core`, and `@superbee/server`; it never
imports CLI source.

The publishable CLI bundles this source into its single zero-runtime-dependency artifact. The
browser UI's restart E2E consumes the same typed `bootUiServer` boundary directly.
