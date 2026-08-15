---
type: Convention
title: Task
governs: Task
path: tasks/
description: A discrete next action that a person or agent can prioritize, own, advance, block, and complete.
fields:
  required:
    - title
    - progress_status
  optional:
    - priority
    - assignee
    - due
  values:
    progress_status:
      - todo
      - in_progress
      - blocked
      - done
      - canceled
    priority:
      - high
      - medium
      - low
  value_descriptions:
    progress_status:
      todo: Ready to be worked but not yet started.
      in_progress: Someone is actively advancing the Task.
      blocked: The Task cannot proceed until a named dependency or condition changes.
      done: The intended work is complete.
      canceled: The Task was intentionally closed without completion.
    priority:
      high: Important or time-sensitive work that should be considered before ordinary Tasks.
      medium: Normal planned work without exceptional urgency.
      low: Optional or opportunistic work that may wait behind higher priorities.
  terminal:
    progress_status:
      - done
      - canceled
  descriptions:
    progress_status: Current lifecycle state of the work.
    priority: Relative importance; absence means unprioritized.
    assignee: Advisory identity responsible for the next action; not authentication or authorization.
    due: Target calendar date, authored as YYYY-MM-DD.
links:
  depends on: Task
  part of: Project
link_descriptions:
  depends on: A prerequisite Task that should complete before this Task can proceed.
  part of: The optional Project whose outcome this Task advances.
freshness_horizon: 30d
---
# Task

A discrete next action. A Task may be captured without a Project or priority, while free-form
Markdown remains available for context, acceptance notes, or agent working material.

Use `depends on` for prerequisite Tasks and `part of` for the optional Project whose outcome the
Task advances. Author `due` as a `YYYY-MM-DD` calendar date.
