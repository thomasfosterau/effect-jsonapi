---
"@thomasfosterau/effect-jsonapi": minor
---

Add the opt-in text filter operators `contains`, `startsWith` and `endsWith` for string attributes, declared by name (`Filter.able(["eq", "contains"])`), never by `filter: true`. They decode to a new `Filter.Text` node, built with `Filter.contains` / `startsWith` / `endsWith`, whose value is the unescaped fragment. `Filter.Operator` and `Filter.operators` now cover the whole vocabulary; `Filter.CoreOperator` / `Filter.coreOperators` name what `filter: true` declares. `Filter.Ast` takes a second parameter naming the fields that may carry a `Text` node, which `Query.FilterAst` fills from the resource (`Query.FilterTextFields`). The untyped `Filter.Node` includes `Text`, so an exhaustive match over `Filter.Node` needs a `Text` case.
