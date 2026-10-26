# Security policy

## Reporting a vulnerability

Report a suspected vulnerability through a private
[GitHub Security Advisory](https://github.com/Holaxis-ai/superbee/security/advisories/new).
This route works from a fresh clone and does not depend on a Superbee bundle, installed Agent Skill,
CLI setup, board sync, or bundle visibility.

Do not open a public issue, pull request, or discussion for a suspected vulnerability. Do not put
exploit mechanisms, reachability analysis, reproductions, payloads, credentials, tokens, secrets, or
other sensitive security details in any synchronized Superbee bundle or other public repository
artifact. This rule applies even when the repository or bundle is believed to be private.

If an externally exploitable issue is already present on `main`, stop public work and use the private
advisory immediately. Use the same private advisory for sensitive pre-merge or unreleased findings;
do not force those details through a public PR or synchronized board merely because the vulnerable
code has not shipped.

The advisory should contain only the information maintainers need to assess and reproduce the issue.
Repository and synchronized-bundle artifacts may contain a sanitized coordination pointer after a
maintainer decides it is safe, but the advisory remains the authority for sensitive mechanisms and
evidence.

If the advisory route is unavailable, stop rather than publishing. Use a previously trusted private
maintainer channel to establish contact without placing vulnerability details in a public message.
There is no public fallback for sensitive disclosure.

## Remediation and disclosure

For confirmed vulnerabilities in distributed versions, our default is private investigation and
remediation, a verified fixed release, and timely public disclosure through a GitHub Security
Advisory. Published advisories explain the impact, affected and patched versions, and recommended
upgrade or mitigation. A scanner alert alone does not establish a vulnerability.

A human maintainer authorizes disclosure. Where publication is withheld, maintainers record the
reason and conditions for reconsideration. Sensitive investigation evidence remains in private
advisory records.

Maintainers use the selected project bundle's `docs/security-disclosure-procedure` for the internal
procedure. It supports this public policy and does not replace the private reporting route above.

## Fail-closed privacy rule

Repository visibility and bundle visibility are not privacy controls for vulnerability details. If
visibility is unknown, changing, stale, mismatched between repository and bundle, or cannot be
verified, treat the destination as public and keep the details out. A bundle sync failure or stale or
missing Agent Skill does not relax this rule.

Any future relaxation requires a separate reviewed security-policy change and an explicit visibility
classifier. Unknown, unavailable, stale, or mismatched classifier results must preserve the private
advisory route and the prohibition on synchronized sensitive details.
