# Temporary Windows extraction parity runner

This migration tool compares two **trusted local CLI tarballs** before and after Windows
extraction. It is outside product workspaces and adds no runtime dependencies. It is not a
sandbox: artifact code executes as the current user. Environment isolation prevents accidental
use of ordinary host settings; it cannot constrain malicious artifacts or prove an absence of
arbitrary writes. Run only reviewed artifacts. Installation is offline with lifecycle scripts
suppressed; supported artifacts have zero runtime dependencies.

## Run

Node 20+ and npm are required. No repository build or source imports occur during comparison.
First freeze a clean baseline tarball. Keep its source SHA and digest with the comparison report.
Both sides must report their supplied source SHA, clean state and build channel through
`version --json`; the executable's reported hash is independently verified against its bytes.
Public export mappings, emitted declaration files and importable export names are also checked.
The tarball digest is verified before installation. A digest establishes identity, not trust.

```sh
node tools/migrations/windows-extraction/run.mjs \
  --baseline /absolute/baseline.tgz --candidate /absolute/candidate.tgz \
  --baseline-sha256 BASELINE_64_HEX --candidate-sha256 CANDIDATE_64_HEX \
  --baseline-source BASELINE_40_HEX --candidate-source CANDIDATE_40_HEX \
  --baseline-channel npm-package --candidate-channel npm-package \
  --scenarios knowledge,integrations,private-state,process \
  --report /absolute/parity-report.json
```

Use the same path, digest and source on both sides for the required baseline self-comparison.
Exit 0 means every **selected** scenario passed its assertions and differential comparison.
Exit 1 means a behavior, comparison, installation or cleanup failure; exit 2 means invalid CLI
arguments. The JSON report retains raw commands, stdout, stderr, exits, document snapshots,
file bytes (base64), modes, artifact identity, normalized values, differences and failures.
The temporary installation/config/state/project tree is removed even on failure. Reports may
contain local paths and supplied artifact data; retain them outside the code checkout.

| Module | Responsibility |
| --- | --- |
| `artifact.mjs` | Offline global-prefix installation and digest/build identity validation |
| `process.mjs` | Environment allowlist, bounded subprocess/dialogue runner and file capture |
| `scenarios.mjs` | Explicit adapters and assertions for existing behavior contracts |
| `compare.mjs` | Narrow normalization, comparison and optional input-graph exclusion |
| `run.mjs` | Explicit selection, report lifecycle and cleanup |
| `harness.test.mjs` | Comparator red controls and runner tests |

## Coverage and owning anchors

| Scenario | Covered behavior | Existing owning evidence |
| --- | --- | --- |
| knowledge | Bare init; create/read; body and unknown frontmatter preservation; field update; actual-byte version check; stale CAS refusal with no lost update; link/list/status; create-only refusal | `scripts/verify-npm-package.mjs`, CLI `doc-cli-integration.test.ts`, `init-create-only.test.ts`, core version/CAS tests |
| integrations | User skill and hook install/status/uninstall at relocated Claude/Codex config roots; generated absolute command; retained config/skill files | `scripts/verify-npm-package.mjs`, `host-config-root-agreement.test.ts`, `hook-command-preference.test.ts` |
| private-state | Canonical root, ownership marker, POSIX private modes, catalog registration/resolution, idempotency, record preservation and lock cleanup | `user-state-initialization.test.ts`, `catalog-cli-integration.test.ts` |
| process | Real MCP initialize and `list_views` roundtrip with response barriers and EOF; private worker malformed argv/input refusal; MCP error channel separation | `mcp-stdio.test.ts`, `ui-managed-authority.test.ts`, `update-orientation.test.ts` |

These are small CLI adapters, not copies of the entire owning suites. The same fixture literals
are constructed separately for each artifact. Ordinary tests retain interrupted migration,
managed listener reuse/ownership, adversarial filesystem concurrency, and backend constructor
contracts. These are **not** claimed as comparator coverage. The tool does not establish full
extraction readiness. Native Windows proof requires running both artifacts on the same actual
Windows runner; macOS/Linux execution and injected platform mocks do not provide it.

Knowledge normalization only handles the fixture actor's generated frontmatter `generated.at`
and its documented output projections, after each raw persisted version token is SHA-256
validated. The stale contender uses its run's observed token and must exit 5 without writing.
The document body, legacy/user timestamps, unknown fields and attribution are preserved.
Fixture roots are substituted only in command path/help/error fields and fixture-owned host
configuration/catalog evidence. No Windows-looking string, arbitrary timestamp or arbitrary
hash is discarded. The generated catalog ID must match the catalog schema and consistent
register/resolve behavior. Package identity is recorded separately, not erased from assets.
There is no installation-name allowance yet: a rename that changes output/assets fails and
needs an explicit reviewed allowed-difference rule.

## Optional future candidate graph gate

The current baseline contains Windows code and is valid input. Candidate exclusion is enabled
only with `--candidate-inputs /absolute/build-inputs.json`. The separately supplied manifest is:

```json
{
  "schema": "superbee.windows-extraction.inputs.v1",
  "source": "40 lowercase hex characters",
  "artifact_sha256": "64 lowercase hex characters",
  "inputs": ["packages/core/src/index.ts", "packages/cli/src/index.ts"]
}
```

The source/digest must match the candidate. Every path is tested for Windows/win32 components;
empty inputs or unknown manifest fields fail. This is a contamination detector over supplied
build inputs, not proof that the caller supplied a complete graph. Extraction review must
verify completeness from the actual bundler metafile/dependency graph and keep permanent graph
assertions in owning suites. Do not pass a hand-picked clean subset as complete evidence.

## Test and retire

```sh
node --test tools/migrations/windows-extraction/harness.test.mjs
PARITY_SELF_REPORT=/absolute/parity-report.json node --test tools/migrations/windows-extraction/harness.test.mjs
```

The ordinary unit run explicitly skips the retained-report check when no report is supplied;
it never counts this as an artifact parity pass. Red controls cover wrong exits, missing
persisted fields, wrong state paths, bypassed refusal, Windows dependency contamination and
real user content hidden by an overbroad normalizer. The root `test:scripts` command contains
one temporary explicit entry, so existing `ci:scripts` executes the harness tests. It does not
fetch a historical tarball or claim an artifact comparison in CI.

Remove this tool in a reviewed cleanup **after macOS/Linux extraction has exact-SHA review,
QA, CI evidence and human acceptance**, without waiting for a Windows community maintainer:

```sh
git rm -r tools/migrations/windows-extraction
```

Also remove the exact `tools/migrations/windows-extraction/harness.test.mjs` argument from root
`package.json`'s `test:scripts`. Verify that supported builds and owning suites run without this
directory and that no production/workflow imports reference it. Preserve artifact/source IDs,
reports, verdicts and the cleanup SHA in Superbee task `tasks/windows-extraction-parity-harness`.
Git history preserves the retired tool. Permanent backend/instance isolation and package graph
contracts must not depend on this runner or on archived baseline artifacts. A Windows successor
retains its own independent native acceptance requirement and experimental status where needed.
