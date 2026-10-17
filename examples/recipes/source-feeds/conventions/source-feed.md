---
type: Convention
title: Source Feed
governs: Source Feed
path: source-feeds/
description: 'A monitored source (structured feed, official page or declared Connector source) and the policy for what its changes may do: which fields it owns and which changes need judgment.'
fields:
  required:
    - title
    - url
    - owned_fields
  optional:
    - connector
    - source
    - feed_kind
    - target_kind
    - poll_interval
    - auto_apply
    - needs_review
    - completeness
    - missing_threshold
    - exclude_pattern
    - retention
    - profile
    - extract_rule
    - wall_time_zone
    - terms_url
    - rights_note
    - last_observed_at
    - description
  types:
    url: https-url
    owned_fields: string-list
    auto_apply: string-list
    needs_review: string-list
    missing_threshold: integer
    terms_url: https-url
    last_observed_at: datetime
  values:
    feed_kind:
      - ics
      - rss
      - json-api
      - html-page
      - connector
    completeness:
      - complete
      - partial
    retention:
      - snapshot-ok
      - live-only
  descriptions:
    url: The provider identity of the feed, as documents name it in `sources[].resource`. For a Connector source, a resource its identity template admits, byte for byte.
    owned_fields: Fields this feed is authoritative for. The overlay may write only these; editor-owned fields are refused. For a Connector source, a subset of the source's mapping keys.
    connector: For a Connector-backed feed, the id of the Connector document (connectors/<slug>).
    source: For a Connector-backed feed, the name of the Connector source this feed binds to.
    feed_kind: 'How the source is read. One of: ics, rss, json-api, html-page, connector.'
    target_kind: The Kind of the documents this feed overlays. For a Connector source, the source's target Kind.
    auto_apply: Change kinds applied without judgment (e.g. changed).
    needs_review: Change kinds that raise a Signal for an agent or human (e.g. new, canceled, disappeared, page-changed).
    completeness: 'Whether one observation lists every current record for its window. Only a complete feed may ever imply that a record disappeared. One of: complete, partial. A Connector source''s value wins.'
    missing_threshold: Consecutive complete observations a record must be absent from before a `disappeared` change is raised.
    exclude_pattern: 'Editorial exclusion: a case-insensitive pattern on record titles. Matching records are still observed and stored but never presented.'
    retention: 'Whether observed records may be captured into a published snapshot (snapshot-ok) or may only be shown live (live-only), per the provider''s terms. One of: snapshot-ok, live-only.'
    profile: Name of the provider profile that decodes this source. A Connector source's value wins.
    extract_rule: 'For configurable profiles: the extraction rule as JSON text. Configuration, not code.'
    wall_time_zone: IANA zone to read this provider's times in when it labels local wall-clock times as UTC. A recorded judgment for one feed, set only with evidence; never guessed and never a default.
    terms_url: The provider's terms of use for this source.
    rights_note: What the provider's terms allow, in a sentence.
    last_observed_at: When the source was last observed.
freshness_horizon: 30d
---
# Source Feed

A monitored source and the policy for what its changes may do: which fields it owns and which
changes need judgment.
