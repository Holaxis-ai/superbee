---
type: Recipe
id: personal-task-system
title: Personal Task System
version: "1"
summary: "A portable personal task model with a live, human-editable board."
content_policy: definitions-only
references:
  - references/view-authoring-v0.md
pages:
  - registry: views-registry/personal-task-system-board.md
    entry: views/personal-task-system/board.html
---
# Personal Task System

Installs the portable Task and Project data model plus a live board over that model. Tasks may stand
alone or link to an optional Project, and may declare dependencies on other Tasks. The board lets a
human filter and inspect the same data agents use, then propose workflow state, priority, assignee, and due
date changes through trusted shell confirmation.

This definitions-only package carries no Task or Project instances. Installing it gives an empty,
ready-to-use operating model rather than another person's work.
