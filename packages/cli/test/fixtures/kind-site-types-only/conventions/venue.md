---
type: Convention
title: Venue
governs: Venue
path: venues/
timestamp: 2026-10-01T12:00:00Z
fields:
  required: [title, latitude]
  optional: [website, topics, opened]
  values:
    topics: [live-music, history]
  descriptions:
    latitude: Decimal degrees north.
x_field_types:
  latitude: latitude
  website: https-url
  topics: string-list
  opened: date
x_field_values:
  topics: [live-music, history, parks]
---

# Venue

A place people go. Site tooling reads the `x_` keys; core does not.
