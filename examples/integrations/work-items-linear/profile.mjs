/** Offline projection double. Never calls transport, and is not in the public profile catalog. */
export const LINEAR_FIELD_COVERAGE = Object.freeze({
  mapped: ["id", "identifier", "title", "url", "team", "state", "priority", "estimate", "labels", "assignee", "createdAt", "updatedAt", "completedAt", "canceledAt", "dueDate", "archivedAt", "trashed"],
  properties: ["number", "project", "delegate"],
  ignored: ["description", "previousIdentifiers", "parent", "cycle", "projectMilestone", "attachments", "relations"],
});
export function uncoveredLinearFields(issue) {
  const covered = new Set(Object.values(LINEAR_FIELD_COVERAGE).flat());
  return Object.keys(issue).filter(key => !covered.has(key));
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function text(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`invalid fixture ${name}`);
  return value;
}
export function normalizeLinearIssue(issue, parameters) {
  if (!object(issue) || issue.team?.id !== parameters.team) throw new Error("issue outside bound Linear team");
  const state = text(issue.state?.type, "state.type");
  const knownState = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"].includes(state);
  const terminal = state === "completed" ? issue.completedAt : ["canceled", "duplicate"].includes(state) ? issue.canceledAt : null;
  if (!Array.isArray(issue.labels?.nodes)) throw new Error("fixture labels require nodes");
  const labels = issue.labels.nodes.map(label => {
    const name = text(label?.name, "label.name");
    return label.parent == null ? name : `${text(label.parent.name, "label.parent.name")}/${name}`;
  });
  const assignees = issue.assignee == null ? [] : [`linear:${text(issue.assignee.displayName, "assignee.displayName")}`];
  return {
    id: text(issue.id, "id"), identifier: text(issue.identifier, "identifier"), title: text(issue.title, "title"), url: text(issue.url, "url"),
    team_key: text(issue.team.key, "team.key"), state_name: text(issue.state.name, "state.name"), state_type: state,
    ...(knownState ? {close_reason: ({completed: "completed", canceled: "not_planned", duplicate: "duplicate"})[state] ?? null, closed_at: terminal ?? null} : {}),
    priority: issue.priority, estimate: issue.estimate,
    labels: [...new Set(labels)].sort(), assignees,
    created_at: issue.createdAt, updated_at: issue.updatedAt, due_on: issue.dueDate,
    source_presence: issue.trashed === true ? "gone" : issue.archivedAt != null ? "archived" : "present",
  };
}
/** Scalars suitable for the existing overlay sourceProperties hook, not a new Project Kind. */
export function linearSourceProperties(issue) {
  return {number: issue.number, team_key: issue.team.key, estimate_scale: issue.team.issueEstimationType,
    ...(issue.project ? {project: issue.project.id} : {}), ...(issue.delegate ? {delegate: issue.delegate.id} : {})};
}
export default Object.freeze({
  id: "linear-issues-fixture", version: 1, kind: "extension",
  validateSpec(spec) {return object(spec) && Array.isArray(spec.issues) ? {ok: true, spec} : {ok: false, errors: [{path: "/issues", message: "recorded fixture issues required"}]};},
  hostsFor: () => [],
  async observe({spec, bound}) {
    return {records: spec.issues.map(issue => normalizeLinearIssue(issue, bound.parameters)), nextCursor: null, more: false, complete: false};
  },
});
