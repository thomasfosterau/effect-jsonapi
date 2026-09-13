---
"@thomasfosterau/effect-jsonapi": minor
---

**Every comma-separated query family now accepts the repeated-key spelling, not just `include`.**
(#102)

`Query.schema`'s `sort` and `fields[TYPE]` options applied `Repeatable` (the codec that accepts
`UrlParams.toRecord`'s array shape for a repeated key) at `include` only — `?sort=-createdAt,title`
decoded, but the equivalent `?sort=-createdAt&sort=title` was a 400, with no principle
distinguishing the two spellings of the same grammar. Both now decode identically, in any mix:

```ts
// all three decode to the same sort list
"?sort=-createdAt,title"
"?sort=-createdAt&sort=title"
"?sort=-createdAt&sort=title,body" // the mixed form
```

The same fix reaches `fields[TYPE]` and, at its list-valued positions (the shorthand `filter[f]`,
`filter[f][op]`, and a group form condition's `[value]` member), the `filter` grammar
(`docs/filter-grammar.md` §2) — `filter[status]=open&filter[status]=done` now decodes the same as
`filter[status]=open,done`. A repeated key everywhere else in the filter grammar (a group's
`[conjunction]`, any `[memberOf]`, a condition's `[path]` / `[operator]`) is still a 400: those
positions take exactly one scalar. Encoding is unchanged — always the single canonical comma form.

The standalone constructors — `Query.Include`, `Query.Fieldset`, `Query.Sort` — compose the same
`Repeatable` widening under their item codec, so a consumer building a query from those pieces
directly (rather than through `Query.schema`) gets the same repeated-key acceptance.

**Behaviour change: an empty comma segment is now dropped, not rejected.** `?include=a,,b` and
`?include=a,b,` (a double comma, or a leading/trailing one) previously reached the item schema as an
empty-string element and failed with an unhelpful "not a valid item name" — the grammar has no way
to spell an intentional empty item, so a gap is a stray separator, not a member of the set. Both now
decode as `["a", "b"]`; this applies to `include`, `fields[TYPE]` and `sort` alike.
