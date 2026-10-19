import {restJsonProfile, nextLinkTarget} from "@superbee/core/source-profiles";
import {unsupportedContent} from "@superbee/core/source-engine";
import {createSourceProfile, normalizeGithubIssue as normalize, uncoveredGithubFields} from "../src/profile.js";
const helpers = Object.freeze({restJsonProfile, nextLinkTarget, unsupportedContent});
export const githubIssuesProfile = createSourceProfile(helpers);
export const normalizeGithubIssue = (issue: Record<string, unknown>, parameters: Readonly<Record<string, string>>) => normalize(issue, parameters, helpers);
export {uncoveredGithubFields};
