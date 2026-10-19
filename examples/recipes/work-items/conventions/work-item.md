---
type: Convention
title: Work Item
governs: Work Item
path: work-items/
description: >-
  One issue, story or task in an external tracker, normalized across tools. The
  connector owns the facts the tool states; people own the notes and tags.
links:
  child of: Work Item
  blocked by: Work Item
  duplicate of: Work Item
link_descriptions:
  child of: The parent item (a GitHub sub-issue parent, a Linear or Jira parent).
  blocked by: An item that must finish before this one proceeds; stored on the blocked item only.
  duplicate of: The item this one duplicates.
fields:
  required: [title]
  optional:
    - key
    - url
    - scope
    - item_type
    - state_category
    - source_state
    - close_reason
    - priority
    - estimate
    - assignees
    - labels
    - opened_at
    - source_updated_at
    - closed_at
    - due_on
    - source_presence
    - code_links
  types:
    url: https-url
    estimate: number
    assignees: string-list
    labels: string-list
    opened_at: datetime
    source_updated_at: datetime
    closed_at: datetime
    due_on: date
    code_links: https-url-list
  values:
    state_category: [triage, backlog, todo, in_progress, done, canceled]
    close_reason: [completed, not_planned, duplicate]
    priority: [none, urgent, high, medium, low]
    source_presence: [present, archived, gone]
  terminal:
    state_category: [done, canceled]
  value_descriptions:
    state_category:
      triage: Awaiting a decision on whether to take it.
      backlog: Accepted and unscheduled.
      todo: Ready or scheduled; the default for an open item with no finer state.
      in_progress: Someone is working on it.
      done: Finished as intended.
      canceled: Closed without finishing, including not planned and duplicate.
    close_reason:
      completed: Finished as intended.
      not_planned: Closed without doing it.
      duplicate: Closed as a duplicate of another item.
    priority:
      none: The tool says no priority.
      urgent: The tool's highest level.
      high: Above normal.
      medium: Normal.
      low: Below normal, including a tool's lowest level.
    source_presence:
      present: The source still lists it.
      archived: The source keeps it read-only.
      gone: The source says it no longer exists (trashed), or a mirror-mode sync found it missing.
  descriptions:
    title: Summary line as the tool shows it.
    key: Human key in the tool (owner/repo#42, ENG-123, PROJ-123); it changes when the item moves.
    url: Browser URL of the item.
    scope: The container the tool files it under, such as a repository, team key or project key.
    item_type: The tool's own type name (Bug, Feature, Story); never normalized.
    state_category: The one normalized workflow state, mapped from the tool's state through a declared table; an unknown native state keeps the last value and raises a finding.
    source_state: The tool's own state name, written as given.
    close_reason: Why a terminal item stopped; absent while open.
    priority: Normalized priority where the tool has one.
    estimate: Points or size on the tool's own scale; the scale is a property of the sources entry.
    assignees: Tool handles prefixed by the tool (github:octocat), sorted; identity across tools is never asserted.
    labels: Label names as the tool spells them, sorted; a grouped label as Group/Label.
    opened_at: Created at the source.
    source_updated_at: The source's last change time for the item.
    closed_at: Entered a terminal state at the source; absent while open.
    due_on: Due date kept on the item itself.
    source_presence: Whether the source still shows the item.
    code_links: Pull request URLs the tool links to the item, sorted.
---
# Work Item

A Work Item mirrors one item in a tracker. The connector's Source Feed names the fields it owns
and writes them under compare-and-swap; everything else, the body above all, belongs to people
and agents. A field you change by hand stays yours: the next sync keeps your value and raises a
Signal instead of overwriting it.

Until mirror mode, a new item at the source arrives as a Signal. Adopt it by creating a Work Item
with the title the Signal shows and a `sources` entry carrying the Signal's provider and external
id, and nothing else. The next sync fills every field the connector owns in one write; a title you
wrote differently is kept and signalled.

To work a synced item, create its Task with `superbee new "Task" tasks/work-<item slug>` (one id
per item, so a second agent is refused) and link the Task to the item with the text `works on`;
claim the Task. A Work Item carries no claim of its own.
