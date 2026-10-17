/**
 * `@superbee/core/bundle-health`: the health report behind `superbee status`, computed from a core
 * `Bundle` on any backend. The caller resolves what lives outside the bundle (bound copies of its
 * dependencies, the clock, a fallback bundle id) and presents the report; the `superbee` CLI is one
 * such caller. It also holds `bundleKindFindings`, the one rule for the Kind problems a strict host
 * write would refuse, which publish preview and hosted bundle creation run. Storage-neutral: no Node
 * globals or builtins.
 */
export { bundleHealth } from "./report.js";
export type {
  BindDependencies,
  BundleHealthOptions,
  BundleHealthReport,
  CrossBundleHealth,
  CrossLinkTypeViolationRow,
  CrossUnresolvedRow,
  DanglingEntryRow,
  DependencyProblemRow,
  DependencyRow,
  DocTypeRow,
  FieldValueRow,
  InvalidRegistrationRow,
  KindLintRow,
  LegacyNamingFindings,
  LinkTypeViolationRow,
  MalformedRow,
  MissingExpectedRow,
  OkfUpgradeFinding,
  StaleRow,
  StatusFieldRow,
  UnresolvedLinkRow,
  ValueRow,
  ViewSurfaceHealth,
} from "./report.js";
export { bundleKindFindings, bundleKindRegistry, documentKindFinding, isRegistryConvention } from "./kind-findings.js";
export type { BundleKindFindings, KindFinding, KindWriteIdentity } from "./kind-findings.js";
export { LEGACY_PAGE_TYPE_NAME, isLegacyPageDoc } from "./legacy-page.js";
