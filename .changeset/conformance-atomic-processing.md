---
"@thomasfosterau/effect-jsonapi": minor
---

**The conformance kit now checks how a server processes atomic operations, judged by what it stored rather than by its answer alone (#164).** With `mutating: true` and a `writes` fixture, three rules that were declared and skipped now run against an `Endpoint.operations` endpoint, and the `Atomic operations processing` entry is gone from `Conformance.gaps`:

- `spec/atomic/lid-resolution` `add`s a resource under a `lid` and names it by that `lid` in a later operation of the same request — as linkage in another fixture's `add`, when that fixture's payload links to the first one's type, and as the target of an `update` carrying the fixture's patch, when there is one — then reads back what the later operation should have changed, by the id the server gave it.
- `spec/atomic/all-or-nothing` lists the type's collection, sends an `add` followed by a `remove` naming a `lid` no operation assigned, and lists it again. The request must be refused with an error document, and a resource that appeared in between with the fixture's attributes fails the rule — and is recorded in `Report.writes` and handed to `cleanup`. The failure mode is the absent `lid`, so the fixture supplies no invalid operation.
- `spec/atomic/results-order` is new: an `add` then a `remove` of the same resource by `lid` must be answered with two result objects in that order, the created resource first and no data second. That resource is recorded as `deleted` when a read confirms the request's own `remove` removed it.

`lid-resolution` needs a single-resource GET to read back through and `all-or-nothing` a collection GET to list; without one, each skips naming what is missing. The blog example passes all three.
