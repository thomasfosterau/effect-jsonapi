---
"@thomasfosterau/effect-jsonapi": minor
---

`Assemble.edgePage` takes the request's other query pairs as `input.query` (`Query.canonicalPairs(listQuery)(query)`), as `Assemble.Pagination.query` already does for `Assemble.collection` (#569). Every pagination link of an edge page then carries them, so a filtered or sorted edge page's `next` keeps its `filter[…]` and `sort`. Without it, links are built as before.
