---
type: Convention
title: Project
governs: Project
path: projects/
description: A durable outcome or body of work that groups related Tasks and preserves context across them.
fields:
  required:
    - title
    - progress_status
  optional:
    - description
  values:
    progress_status:
      - active
      - paused
      - archived
  value_descriptions:
    progress_status:
      active: The Project is currently being pursued.
      paused: Work is intentionally suspended but may resume.
      archived: The Project is no longer active and is retained for context.
  terminal:
    progress_status:
      - archived
  descriptions:
    progress_status: Whether the Project is active work, intentionally paused, or archived.
    description: A concise statement of the Project's intended outcome or scope.
expects_inbound:
  part of: Task
freshness_horizon: 180d
---
# Project

A durable outcome or body of work that groups related Tasks and preserves context across them. A
Project may carry free-form Markdown, but no body headings are required.
