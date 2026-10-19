/** Explicitly composed offline example using the separately installed GitHub package. */
import {restJsonProfile, nextLinkTarget} from "@superbee/core/source-profiles";
import {unsupportedContent} from "@superbee/core/source-engine";
import {createSourceProfile, normalizeGithubIssue as normalize} from "@superbee/integration-github/profile";
const helpers = Object.freeze({restJsonProfile, nextLinkTarget, unsupportedContent});
export default createSourceProfile(helpers);
export const normalizeGithubIssue = (issue, parameters) => normalize(issue, parameters, helpers);
export {GITHUB_FIELD_COVERAGE, uncoveredGithubFields} from "@superbee/integration-github/profile";
