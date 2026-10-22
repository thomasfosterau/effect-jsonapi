---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance`'s `profile/filter/evaluation` rule now probes more of the filter profile's evaluation semantics (`docs/filter-grammar.md` §6). Each new group of trees is judged on the first field the server decides anything on, and a group with no field to probe is named in the outcome's note:

- On an attribute that is NULL on some resources, `lt`, `lte` and `gt` join `ne` and `gte`. A server that sorts NULL below every value fails them (F-CMP-1, F-CMP-2, F-ORD-1).
- On an attribute that is never NULL in the sample and has two or more values, the rule sends `lt`, `lte`, `gt` and `gte` at a pivot (the median of its values in F-ORD-1's order), so each one splits the sample. A server that orders numbers as text fails them. It also sends `isnull=true`, which F-ISNULL-4 says matches nothing.
- On a to-one relationship whose linkage every resource shows, the value is the related id (F-EVAL-4, F-ORD-5). The rule sends `eq`, `ne` and `nin`, plus `isnull` both ways when the linkage is empty on some resources; relationships with empty linkage are tried first. It never sends an ordering operator to a relationship, and never filters on one that shows no linkage.
- When the endpoint declares `fields[TYPE]`, the rule sends an `eq` filter with a sparse fieldset that leaves the filtered field out. The match set must not change (F-EVAL-6).

A sample with no attribute that is sometimes NULL used to decide the empty groups alone; it now decides every group it has a field for. The `Conformance.gaps` entry is renamed "The filter profile's evaluation semantics, beyond what the sample shows". It now lists what the rule cannot or does not probe: exact string comparison and sub-millisecond precision beyond the values the sample holds, relationships without linkage, the corollaries F-CONS-2 to F-CONS-7, and the refusals F-ERR-4 and F-ERR-5.
