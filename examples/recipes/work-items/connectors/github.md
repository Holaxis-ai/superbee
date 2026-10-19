---
type: Connector
title: GitHub issues
description: GitHub issues as Work Items through a GitHub App installation, one repository per Source Feed.
version: "1"
auth:
  kind: github-app
  permissions: { issues: read, metadata: read }
record_sources:
  - name: issues
    profile: github-issues
    request:
      host: api.github.com
      method: GET
      path: /repos/{owner}/{repo}/issues
      items: ""
      query: { state: all, sort: updated, direction: asc, per_page: 100 }
      headers: { accept: application/vnd.github+json, x-github-api-version: "2026-03-10" }
      paging: { kind: link-header }
      complete: always
    target_kind: Work Item
    mode: overlay
    identity:
      resource: "https://github.com/{owner}/{repo}"
      id: "{node_id}"
    fields:
      title: title
      key: key
      url: html_url
      scope: repository
      item_type: type_name
      source_state: state
      state_category:
        from: state_key
        values:
          open: todo
          "open:reopened": todo
          closed: done
          "closed:completed": done
          "closed:not_planned": canceled
          "closed:duplicate": canceled
        unmapped: keep
      close_reason:
        from: close_reason
        values: { completed: completed, not_planned: not_planned, duplicate: duplicate }
        unmapped: keep
      labels: labels
      assignees: assignees
      opened_at: created_at
      source_updated_at: updated_at
      closed_at: closed_at
    completeness: complete
actions: []
events: []
---
# GitHub issues

Reads one repository's issues through the installation's `issues: read` permission and maps
them onto the Work Item Kind. Pull requests in the listing are skipped. Milestones, Projects v2
fields and relationships arrive in later versions.
