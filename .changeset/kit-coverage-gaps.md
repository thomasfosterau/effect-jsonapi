---
"@thomasfosterau/effect-jsonapi": minor
---

The conformance kit gains seven spec-tier rules: `spec/document/no-unrequested-included` (a one-path `include` brings in only that path's targets), `spec/document/relationship-data-identifiers` (a relationship endpoint's primary data is resource linkage), `spec/pagination/links-placement` (pagination links only beside a collection, each a link or `null`), `spec/status/relationship-not-found` and `spec/status/related-not-found` (404 under an absent resource), `spec/status/related-to-one-null` (an empty to-one related URL answers 200 with `data: null`) and, with the write fixture, `spec/document/at-members-ignored` (a create carrying @-members is not refused for them).
