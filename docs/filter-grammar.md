# Filter grammar

The definition of the `filter` query family, and of the JSON:API **profile** it publishes ([§5](#5-profile-uri)). It fixes both halves of that profile, and both are normative:

- the **syntax** — the AST, the operator core, the URL surface, the canonical encoding ([§1](#1-the-ast)–[§4](#4-the-operator-core-is-closed)) — which two implementations must agree on byte for byte;
- the **semantics** — what a tree means, operator by operator, including NULL ([§6](#6-semantics)) — which two implementations must agree on resource by resource.

The profile also fixes what `?sort=` **orders by** ([§10](#10-sort-order)): the same comparison domain as `filter`, NULL placement, multi-field order and the `id` tiebreak — normative too, and the reason the document is not only about `filter`.

Nothing here defers to another project for its meaning. A third-party implementer needs this document and the JSON:API v1.1 specification, and nothing else.

**Status:** implemented. Tracks [#83](https://github.com/thomasfosterau/effect-jsonapi/issues/83) (epic [#82](https://github.com/thomasfosterau/effect-jsonapi/issues/82)): [#84](https://github.com/thomasfosterau/effect-jsonapi/issues/84) (per-attribute declaration, `Resource.filterable`) and [#86](https://github.com/thomasfosterau/effect-jsonapi/issues/86) (the AST `Filter.Ast`, the codec `Query.Filter` / `filter: true`, the error pointers) are in the package, as is [#85](https://github.com/thomasfosterau/effect-jsonapi/issues/85) (the canonical `self` string, `Query.canonical`). [§6](#6-semantics) is [#116](https://github.com/thomasfosterau/effect-jsonapi/issues/116) (epic [#115](https://github.com/thomasfosterau/effect-jsonapi/issues/115)); the conformance suite that runs it against a server is [#120](https://github.com/thomasfosterau/effect-jsonapi/issues/120). [§10](#10-sort-order) is [#167](https://github.com/thomasfosterau/effect-jsonapi/issues/167), checked by the conformance kit's `profile/sort/ordering`.

## 0. Scope and decisions already taken

Settled in #82, not reopened here:

- Operator core `eq ne lt lte gt gte in nin isnull` plus `and or not` groups. No relationship traversal, no pattern matching, no text search.
- Shorthand desugars into the group form. `filter[f]=v` stays `eq`, `filter[f]=a,b` stays `in`.
- Literals are typed by the attribute schema. `NULL` is not a literal; use `isnull`.
- Semantics are three-valued, and they are **this profile's own** — written out operator by operator in [§6](#6-semantics). The AST itself is syntax: plain data with no evaluator attached.
- Ships as a documented profile URI, not an `ext` extension.

Two things below go further than the issue text and are called out where they occur: [§1.2](#12-fields) admits to-one relationship names as fields (decided with #84), and [§7](#7-error-pointers) records how the error middleware was extended so `source.parameter` is emitted.

## 1. The AST

The AST is an **initial encoding**: plain data, an Effect `Schema` union, no methods. Every consumer — the URL codec here, and whatever evaluates a tree against a store — pattern-matches on it. What that evaluation must produce is [§6](#6-semantics).

### 1.1 Nodes

```ts
type Ast<Field extends string, Literal> =
  | {
      readonly _tag: "Compare";
      readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
      readonly field: Field;
      readonly value: Literal;
    }
  | { readonly _tag: "In"; readonly field: Field; readonly values: NonEmptyReadonlyArray<Literal> }
  | {
      readonly _tag: "NotIn";
      readonly field: Field;
      readonly values: NonEmptyReadonlyArray<Literal>;
    }
  | { readonly _tag: "IsNull"; readonly field: Field; readonly negated: boolean }
  | { readonly _tag: "And"; readonly members: ReadonlyArray<Ast<Field, Literal>> }
  | { readonly _tag: "Or"; readonly members: ReadonlyArray<Ast<Field, Literal>> }
  | { readonly _tag: "Not"; readonly member: Ast<Field, Literal> };
```

Rules the schema enforces:

- `value` and `values` are **typed literals**: the attribute's decoded type (`number`, `Date`, a string-literal union, …), never a raw string and never `null`. The literal type therefore differs per field; at the type level the union is `Compare<"age", number> | Compare<"title", string> | …` over the declared fields, and `Query.Filter(R).Type` narrows `field` to a literal union of the declared names (#84).
- `In` / `NotIn` lists are **non-empty**. An empty list has no URL form (see [§2.3](#23-literals-and-lists)), and a codec that must be total cannot carry a node it cannot encode. Legation's `Predicate.In` with an empty list is a bridge concern (`toFilterAst` returns `None`, or rewrites to `Or([])`).
- `IsNull.negated: true` is `IS NOT NULL`. `NotIn` and negated `IsNull` are redundant with `Not` but are kept because interpreters emit them directly (`NOT IN`, `IS NOT NULL`) and because the shorthand surface names them (`nin`, `isnull=false`).
- `And` / `Or` members are a **set**, not a sequence: order carries no meaning and the codec sorts them ([§3.2](#32-normal-form)). `And([])` is "true", `Or([])` is "false". Both are representable ([§2.4](#24-group-form)); neither is what an absent `filter` decodes to (absent is absent).
- `Not` takes exactly one member of any kind. `Not(Not(x))` is a legal tree and encodes as two nested `NOT` groups; the codec does not simplify it.

The decoded `filter` is **one root node**. Shorthand with several keys decodes to a root `And`; shorthand with one key decodes to that bare condition ([§2.2](#22-shorthand)).

### 1.2 Fields

A field is a **declared name on the primary resource** (#84). No dotted paths, no traversal.

**Decision (accepted, #84).** Fields are the resource's declared attributes (`schema.pipe(Filter.able(...))`, or the `Resource.attribute(schema, { filter })` sugar for it) **plus its declared to-one relationship names** (`Relationship.one(ref, { filter })` / `Relationship.optional(ref, { filter })`), the latter valued by the related resource's id and admitting `eq ne in nin isnull` only — ordering operators make no sense for an id, and declaring one is a definition-time error. This is not traversal: there is no path and the literal is the related id, decoded through the target's `Id` schema. It keeps the README's canonical `filter[author]=9`, `examples/northwind`'s `filter[category]` / `filter[customer]` / `filter[manager]` endpoints and the JSON:API recommendation `GET /comments?filter[post]=1` expressible without exposing foreign keys as attributes, and it covers the empirical table in legation#148 (16 `eq`, values are ids), which is mostly foreign keys. To-many relationships are not fields. "Attribute" below reads as "declared field".

### 1.3 The AST is syntax

The AST carries no evaluator, and the package ships none ([§6.9](#69-decisions-recorded)): the only fold over it is the conformance kit's internal oracle, which judges a server rather than serving one. That is a statement about the data structure, not about the profile: what a tree _means_ — NULL handling, comparison domains, type coercion, the absent-attribute rule and the per-operator truth tables — is [§6](#6-semantics), which is as normative as §1–§4. Two of §6's facts are repeated here because the codec itself needs them: literals are typed by the attribute schema, and `NULL` is not a literal.

## 2. Surface syntax

Two forms, one AST. Every `filter[...]` key is classified by its bracket depth:

| Segments                                  | Form                                  |
| ----------------------------------------- | ------------------------------------- |
| `filter[f]`                               | shorthand, bare                       |
| `filter[f][op]`                           | shorthand, explicit operator          |
| `filter[id][group][…]` / `[condition][…]` | group form                            |
| anything else                             | 400, `source.parameter` names the key |

A repeated key (`filter[a]=1&filter[a]=2`, which `UrlParams.toRecord` surfaces as an array) is accepted at the three list-valued positions — shorthand `filter[a]`, `filter[a][op]`, and a group form condition's `[value]` member — denoting the same set the comma form does: `filter[a]=1&filter[a]=2` decodes identically to `filter[a]=1,2`, and is rejected the same way when `a` has no list operator declared (§2.1). Everywhere else — a group's `[conjunction]`, any `[memberOf]`, a condition's `[path]` / `[operator]` — a repeated key is a 400: those positions take exactly one scalar.

### 2.1 Operators

| Operator | Node      | Literal           | Shorthand                            |
| -------- | --------- | ----------------- | ------------------------------------ |
| `eq`     | `Compare` | one               | `filter[f]=v`, `filter[f][eq]=v`     |
| `ne`     | `Compare` | one               | `filter[f][ne]=v`                    |
| `lt`     | `Compare` | one               | `filter[f][lt]=v`                    |
| `lte`    | `Compare` | one               | `filter[f][lte]=v`                   |
| `gt`     | `Compare` | one               | `filter[f][gt]=v`                    |
| `gte`    | `Compare` | one               | `filter[f][gte]=v`                   |
| `in`     | `In`      | list, ≥ 1         | `filter[f]=a,b`, `filter[f][in]=a,b` |
| `nin`    | `NotIn`   | list, ≥ 1         | `filter[f][nin]=a,b`                 |
| `isnull` | `IsNull`  | `true` \| `false` | `filter[f][isnull]=true`             |

The set is **closed** ([§4](#4-the-operator-core-is-closed)). An operator outside the attribute's declared set, or a name not in this table, is a 400.

### 2.2 Shorthand

- `filter[f]=v` → `Compare { op: "eq", field: f, value: v }` when `v` contains no unescaped comma.
- `filter[f]=a,b` → `In { field: f, values: [a, b] }` when it contains one or more.
- `filter[f][op]=v` → the node for `op` ([§2.1](#21-operators)).
- `filter[f][isnull]=true` → `IsNull { negated: false }`; `=false` → `negated: true`. Any other value is a 400.

Each shorthand key is one condition at the **root**. One key decodes to that condition; several decode to `And([...])`. A `(field, operator)` pair has at most one key in shorthand (`filter[f]=v` and `filter[f][eq]=w` are two keys and both decode, but a third `eq` on `f` has nowhere to go), so `age gt 18 AND age gt 20` needs the group form.

Shorthand is the desugared spelling of the group form: `filter[age][gt]=18` means exactly `filter[c][condition][path]=age&filter[c][condition][operator]=gt&filter[c][condition][value]=18`.

### 2.3 Literals and lists

Every literal position (a bare value, an explicit-operator value, a group-form `value`) is written in one **literal grammar**:

- `\,` is a literal comma, `\\` is a literal backslash.
- A backslash followed by anything else is malformed → 400.
- In a **list position** (`filter[f]=…`, `[in]`, `[nin]`, and group-form `value` for those operators) unescaped commas separate items. In a **scalar position** an unescaped comma is a 400.
- The empty string is a legal literal (`filter[title]=` is `eq ""` on a string attribute; on a number attribute it fails literal decoding). There is no spelling for an empty list, which is why `In` / `NotIn` are non-empty.

After unescaping, each item is decoded by the attribute's **literal codec**, derived from its schema (#84):

| Attribute encoded form (JSON) | Wire string accepted | Decoded literal |
| --- | --- | --- |
| `string` | the string itself | via attribute schema |
| `number` | a strict finite decimal ([§6.6](#66-type-coercion-and-literals)) | via attribute schema |
| `boolean` | `true` \| `false` | via attribute schema |
| `X \| null` (`Schema.NullOr`) | as `X`; `null` is never a literal | via `X` |

`DateFromString` is a `string` on the wire, so `filter[createdAt][gte]=2026-01-01T00:00:00.000Z` decodes to a `Date` and re-encodes via the attribute's own encoder (`toISOString()`), which is also the ISO-8601 UTC text [§6.2](#62-comparison-domains) compares. An attribute whose encoded form is not one of these (a struct, an array) cannot be declared filterable; the declaration may supply an explicit literal codec (`Codec<Type, string>`) for the rare case. An explicit codec must not decode any wire string to `null`: NULL is never a literal ([F-NULL-1](#64-null)), so a value it decodes to `null` is a 400 like any other bad literal, and `isnull` stays the only way to name NULL.

Because literals go through the attribute schema, `filter[priceCents][gt]=abc` and `filter[status]=bogus` (on a literal-union attribute) are 400s with `source.parameter` naming the key, not silent no-matches.

### 2.4 Group form

Drupal-style, for anything shorthand cannot say: `OR`, `NOT`, nesting, or two conditions with the same field and operator. Keys are `filter[<id>][group][<member>]` and `filter[<id>][condition][<member>]`; `<id>` is any string without `[`, `]` or `,` and is **not part of the AST** (ids only wire members to groups).

| Key | Values | Notes |
| --- | --- | --- |
| `filter[g][group][conjunction]` | `AND` \| `OR` \| `NOT` | required; `NOT` must have exactly 1 member |
| `filter[g][group][memberOf]` | a group id | absent → root |
| `filter[c][condition][path]` | a declared field | required |
| `filter[c][condition][operator]` | an operator | required; no default |
| `filter[c][condition][value]` | literal or list ([§2.3](#23-literals-and-lists)) | required (`true`/`false` for `isnull`) |
| `filter[c][condition][memberOf]` | a group id | absent → root |

Decoding:

- A node is a group or a condition, never both; an id used for both is a 400.
- `memberOf` must name a declared group; a cycle or an unknown parent is a 400.
- Root members are every group or condition (shorthand keys included) without `memberOf`. One root member is the root; several become an implicit root `And`.
- A group with no members is `And([])` / `Or([])`. A `NOT` group with zero or more than one member is a 400.
- Mixing shorthand and group keys in one URL is allowed; the shorthand keys are simply root conditions.

Every 400 carries `source.parameter` set to the flat key that failed (`filter[c][condition][operator]`, say); a structural failure (a dangling `memberOf`, a cycle) points at the `memberOf` key that names the missing target (for a cycle, the first cycle member's in input order); a missing required member points at the key that is missing (`filter[c][condition][operator]` when a condition has no operator); an id used as both a group and a condition points at the first key of the second kind; a `NOT` with the wrong arity at its `conjunction` key.

## 3. Canonical encoding

The canonical string is what `self` links carry ([#85](https://github.com/thomasfosterau/effect-jsonapi/issues/85)) and what Legation uses as the identity of a subscription, a coverage window and an HTTP cache tag. So it must be a **function of the AST alone**: two URLs that decode to the same tree canonicalise to the same bytes, whatever their key order, ids, escaping or `[eq]`/bare spelling.

### 3.1 Which form the encoder emits

Shorthand is emitted when, and only when, it decodes back to the same tree:

- The root is a single `Compare` / `In` / `NotIn` / `IsNull`, **or**
- the root is an `And` with two or more members, all of them conditions, whose `(field, operator)` pairs are pairwise distinct.

Everything else (any `Or` or `Not`, any nested group, an `And` with one member or with a repeated `(field, operator)` pair, a bare `And([])`) is emitted in the group form. So is the one case where distinct `(field, operator)` pairs would still share a shorthand key: an `eq` and a two-or-more-value `In` on the same field are both written bare (`filter[f]=…`), so an `And` holding both takes the group form — the test is that the shorthand keys are pairwise distinct. `And` with one member and that member on its own are different trees and get different strings; `decode ∘ encode` is identity.

Within shorthand:

- `eq` is written bare (`filter[f]=v`), never `[eq]`.
- `In` with two or more values is written bare (`filter[f]=a,b`); `In` with one value is `filter[f][in]=v` (bare would decode as `eq`).
- Every other operator is explicit.

### 3.2 Normal form

Decoding normalises; encoding assumes normal form. A tree is in normal form when:

- `In` / `NotIn` values are sorted by their **encoded** wire string (code-point order) and deduplicated.
- `And` / `Or` members are sorted by the **node order** below, and deduplicated.

The node order is total, id-free and structural:

1. Conditions sort before groups.
2. Conditions compare by `field`, then `operator` (as text), then the encoded value list (items joined by `,` after escaping), each code-point-wise.
3. Groups compare by conjunction as text (`AND` < `NOT` < `OR`), then by their (already sorted) members pairwise under this same order, a shorter member list sorting first on a tie.

`decode` always returns a normal-form tree, so the round-trip invariants are:

```
decode(encode(x)) == x                   for every x in normal form
encode(decode(u)) == canonical(u)        for every accepted URL u
decode(canonical(u)) == decode(u)
```

(A generated tree is normalised before the first check; the generator in #86 does this.)

### 3.3 Key order and ids

The canonical form is an ordered list of `(key, value)` pairs. Percent-encoding, bracket escaping and joining with `&` are `Query.canonical`'s job (#85) and identical for every family: it places the `filter[*]` pairs, in exactly this order, between `fields[*]` and `sort`, and serialises with `Query.serialise` (RFC 3986 percent-encoding via `encodeURIComponent`, `[` / `]` left readable in keys, so `\,` is `%5C%2C` and a list's separating comma `%2C`).

- **Shorthand:** pairs sorted by key, code-point order. Because `filter[age]` sorts before `filter[age][gt]` and operator names are compared as text, this is "by field, then operator" without a lookup table.
- **Group form:** ids are assigned by the encoder in pre-order over the normal-form tree, groups as `g0, g1, …` and conditions as `c0, c1, …`, and pairs are emitted in that traversal order, each node's members in the fixed order `conjunction, memberOf` / `path, operator, value, memberOf`. Ids are therefore also a function of the tree.
- **Values:** literals are re-encoded through the attribute schema and the literal grammar, so `filter[limit]=010` canonicalises to `filter[limit]=10` and a date to its ISO form.

### 3.4 Worked examples

Each operator, shorthand and canonical:

| URL | AST |
| --- | --- |
| `filter[status]=open` | `Compare { op: "eq", field: "status", value: "open" }` |
| `filter[status][ne]=done` | `Compare { op: "ne", … }` |
| `filter[age][lt]=18` | `Compare { op: "lt", field: "age", value: 18 }` |
| `filter[age][lte]=18` | `Compare { op: "lte", … }` |
| `filter[age][gt]=18` | `Compare { op: "gt", … }` |
| `filter[age][gte]=18` | `Compare { op: "gte", … }` |
| `filter[priority]=1,2` | `In { field: "priority", values: [1, 2] }` |
| `filter[priority][in]=1` | `In { values: [1] }` |
| `filter[status][nin]=archived,done` | `NotIn { values: ["archived", "done"] }` |
| `filter[deletedAt][isnull]=true` | `IsNull { field: "deletedAt", negated: false }` |
| `filter[deletedAt][isnull]=false` | `IsNull { negated: true }` |
| `filter[title]=Hello\, world` | `Compare { op: "eq", field: "title", value: "Hello, world" }` |

A two-condition filter written three ways, one canonical string:

```
?filter[status]=open&filter[age][gt]=18
?filter[age][gt]=18&filter[status]=open
?filter[c1][condition][path]=status&filter[c1][condition][operator]=eq&filter[c1][condition][value]=open
  &filter[x][condition][path]=age&filter[x][condition][operator]=gt&filter[x][condition][value]=18
```

decode to `And([Compare(gt, age, 18), Compare(eq, status, "open")])` and canonicalise to

```
filter[age][gt]=18&filter[status]=open
```

One nested group, `(status = open AND age > 18) OR (status = done AND age <= 18)`:

```
?filter[or][group][conjunction]=OR
&filter[a][group][conjunction]=AND&filter[a][group][memberOf]=or
&filter[a1][condition][path]=status&filter[a1][condition][operator]=eq&filter[a1][condition][value]=open&filter[a1][condition][memberOf]=a
&filter[a2][condition][path]=age&filter[a2][condition][operator]=gt&filter[a2][condition][value]=18&filter[a2][condition][memberOf]=a
&filter[b][group][conjunction]=AND&filter[b][group][memberOf]=or
&filter[b1][condition][path]=status&filter[b1][condition][operator]=eq&filter[b1][condition][value]=done&filter[b1][condition][memberOf]=b
&filter[b2][condition][path]=age&filter[b2][condition][operator]=lte&filter[b2][condition][value]=18&filter[b2][condition][memberOf]=b
```

decodes to

```
Or([
  And([Compare(gt, age, 18), Compare(eq, status, "open")]),
  And([Compare(lte, age, 18), Compare(eq, status, "done")])
])
```

and canonicalises to the string below: ids reassigned in pre-order; within each `AND` the `age` condition sorts before `status`; and the `gt` group sorts before the `lte` group because both are `AND`, their first members tie on `age`, and `gt` < `lte` as text.

```
filter[g0][group][conjunction]=OR
&filter[g1][group][conjunction]=AND&filter[g1][group][memberOf]=g0
&filter[c0][condition][path]=age&filter[c0][condition][operator]=gt&filter[c0][condition][value]=18&filter[c0][condition][memberOf]=g1
&filter[c1][condition][path]=status&filter[c1][condition][operator]=eq&filter[c1][condition][value]=open&filter[c1][condition][memberOf]=g1
&filter[g2][group][conjunction]=AND&filter[g2][group][memberOf]=g0
&filter[c2][condition][path]=age&filter[c2][condition][operator]=lte&filter[c2][condition][value]=18&filter[c2][condition][memberOf]=g2
&filter[c3][condition][path]=status&filter[c3][condition][operator]=eq&filter[c3][condition][value]=done&filter[c3][condition][memberOf]=g2
```

`NOT (status = open)`:

```
filter[g0][group][conjunction]=NOT
&filter[c0][condition][path]=status&filter[c0][condition][operator]=eq&filter[c0][condition][value]=open&filter[c0][condition][memberOf]=g0
```

## 4. The operator core is closed

`eq ne lt lte gt gte in nin isnull` and `and or not`. Nothing else decodes, and #84's declaration cannot name anything else. Excluded, with the reason each has no portable Postgres / SQLite / JS / IndexedDB semantics:

| Excluded | Why |
| --- | --- |
| `like` / `contains` / `startswith` | `LIKE` escaping and case rules differ between Postgres and SQLite; IndexedDB has no substring index. |
| case-insensitive match (`ilike`, `ieq`) | Case folding is locale- and collation-dependent; [§6.2](#62-comparison-domains) fixes code-point order only. |
| full-text search | Tokenisation, stemming and ranking are engine-specific and non-deterministic across targets. |
| array / JSON operators (`@>`, `?`, `->`) | No SQLite or IndexedDB equivalent; literals would stop being scalars typed by the attribute. |
| regular expressions | Three incompatible regex dialects; unbounded evaluation cost. |
| relationship traversal (`author.name`) | An `EXISTS`; Legation D1 keeps it server-only with no URL form. |
| `between` | Sugar for `gte AND lte`; a second spelling would break canonical identity. |

Adding an operator is a new grammar version and a new profile URI ([§5](#5-profile-uri)).

## 5. Profile URI

The grammar is a JSON:API **profile**, not an `ext`: it constrains how a server interprets `filter[*]`, which the spec leaves to the implementation, and changes nothing about document structure. Servers advertise it on the media type of responses to endpoints that implement it:

```
Content-Type: application/vnd.api+json; profile="https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1"
```

- The URI is exported as a constant (`Filter.PROFILE_URI`, also `Query.FILTER_PROFILE_URI`) and is a version of this document. `v1` is this note; an incompatible change is `v2`. What counts as incompatible, now that the profile has semantics: a new or removed operator, a changed canonical rule, a changed truth table, a changed comparison domain, any change that moves a resource between matching and not matching a filter that was already accepted, or — since [§10](#10-sort-order) — any change to an `S-ORD-*` or `S-MULTI-*` rule that reorders a collection already sorted under `v1`.
- Per the spec, unknown profiles in `Accept` are ignored, never rejected; the existing negotiation middleware already does this (`src/Middleware.ts`, the `profile` branch). Nothing about request handling keys off the profile parameter: an endpoint declared with `filter: true` speaks the grammar whether or not the client names it.
- The URI above is final: `https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1`. It must stay stable now that it is published.

**Decision (accepted, #116): adding [§6](#6-semantics) keeps `v1`.** The alternative was to publish the semantics as `v2` on the grounds that a client which negotiated `v1` negotiated a profile with no stated meaning. `v1` is kept, for three reasons: the operator vocabulary, the URL surface and the canonical form — everything a `v1` implementation actually keys off — are unchanged, so no accepted URL changes its parse or its `self` link; §6 records the reading `v1` already asserted (three-valued, Postgres-normative) rather than choosing a new one, so nothing that conformed before stops conforming; and the URI is a published constant whose stability §5 promises. A `v2` here would cost every advertising server a media-type change and buy nothing. From now on, the rule in the first bullet above applies: a change to a truth table is `v2`, not a clarification of `v1`.

**Decision (proposed, #167): adding [§10](#10-sort-order) keeps `v1` too.** §10 lands as a section of this profile (owner direction on #167), not as a second profile URI or as an unnegotiated README convention, so the remaining question is whether it is a new version. It is not, for four reasons. Nothing a `v1` implementation keys off for `filter` changes: no accepted URL changes its parse, its `self` link or the resources it matches. §6.8 of `v1` already named F-ORD-1's order as the one a server was recommended to sort under, so for a server that took the recommendation §10 adds only the NULL and tie rules. The advertisement does not carry the claim anyway: S-SCOPE-1 applies §10 to every collection that supports `sort`, including endpoints that never speak the grammar and so never advertise the URI, so a `v2` would version a sort claim the media type does not make. And a `v2` costs every advertising server a media-type change and every consumer a changed `Filter.PROFILE_URI` constant, for a section most of them did not negotiate. The cost is stated plainly: a server that advertised `v1` and sorted under a locale collation, or with NULLs first, conformed before §10 and does not now — an outcome §6.8's "not required" allowed. That is the trade-off the owner reviews on #167; the alternative is to publish §10 under its own profile URI (`…/profiles/sort-order/v1`) and leave this one untouched. From now on, the last case in the first bullet above applies: a change that reorders an already-sorted collection is `v2`.

## 6. Semantics

**Normative.** This section defines what a filter tree _means_. It is the profile's own definition: no rule below is inherited from, or deferred to, another project. It is written for a third-party implementer who has the URL surface (§2) and a data store, and needs to answer the same question this library's servers answer.

Every rule carries an identifier (`F-…`). The identifiers are stable and are what a conformance suite ([#120](https://github.com/thomasfosterau/effect-jsonapi/issues/120)) names when it reports a violation; each is phrased so that it can be checked mechanically, from the wire, without knowing how the server stores anything.

Two words are used precisely. **NULL** is the absence of a value for a field on one resource ([§6.4](#64-null)); it is written in capitals to distinguish it from the four-character string `null`, which is an ordinary literal. **UNKNOWN** is the third truth value ([§6.3](#63-truth-tables)); it is not a value a field can hold.

### 6.1 The evaluation model

**F-EVAL-1.** A filter tree is evaluated **against one resource at a time**, independently of every other resource. No operator's result depends on the rest of the collection, on the page being served, or on the order of evaluation.

**F-EVAL-2.** Evaluation yields one of three truth values: TRUE, FALSE or UNKNOWN ([§6.3](#63-truth-tables)).

**F-EVAL-3 (the matching rule).** A resource appears in the response's primary data **if and only if** the root node evaluates to TRUE for it. FALSE and UNKNOWN both exclude it. This is the only rule that turns a truth value into a document, and it is what makes three-valued logic observable: a client cannot tell FALSE from UNKNOWN by looking at one response, but it can tell that `filter[f][ne]=x` and `filter[f]=x` together do not cover every resource ([§6.5](#65-consequences)).

**F-EVAL-4 (the value of a field).** `value(resource, field)` is:

| Field kind | Value | NULL when |
| --- | --- | --- |
| a declared filterable **attribute** | that attribute's value in the resource's JSON representation | the member is JSON `null`, **or** the member is absent |
| a declared filterable **to-one relationship** | the `id` of the related resource, as a JSON string | the linkage is empty (`data: null`) |

An absent attribute member is NULL, not an error and not a distinct fourth thing: a server that omits a member it has no value for and a server that writes `null` answer every filter identically (**F-EVAL-5**). Filtering on a field the resource _definition_ does not declare is a different matter entirely — that is a 400 ([§6.7](#67-the-400-boundary)), decided from the definition alone, before any resource is looked at.

**F-EVAL-6.** `value` is read from the resource's **complete** representation. A sparse fieldset (`fields[TYPE]`) changes what the response carries, never what matches; a filter on an attribute the client did not request is evaluated exactly as if it had.

### 6.2 Comparison domains

The literals in a tree are _decoded_ values — a `Schema.DateFromString` attribute filters by a `Date`, a branded `Schema.Int` by a branded number ([§2.3](#23-literals-and-lists)). The decoded type is a convenience for the handler that receives the tree. **Comparison is not defined on it.**

**F-ORD-1 (the domain rule).** Comparison is defined on the field's **JSON representation** — the form the value takes in a JSON:API document — and in the order of that JSON type. This is why an attribute whose encoded form is not a JSON scalar cannot be declared filterable at all ([§2.3](#23-literals-and-lists)): every filterable field's values, and every literal, are a JSON string, number or boolean.

| JSON type | Order | Equality |
| --- | --- | --- |
| **number** | IEEE-754 numeric order on the double the JSON number denotes | numeric equality (`-0` and `0` are equal) |
| **string** | code-point order (equivalently, UTF-8 byte order) | identical code-point sequences |
| **boolean** | `false` < `true` | identity |

**F-ORD-2 (strings are compared exactly).** No case folding, no locale or ICU collation, no Unicode normalisation (`"é"` as U+00E9 and as U+0065 U+0301 are **different** values, and neither `eq` nor `in` relates them), no trimming, and no blank padding. A server whose store compares text under a locale collation does not conform unless it forces binary comparison for filter evaluation (`COLLATE "C"` in Postgres, `COLLATE BINARY` in SQLite); a fixed-width padded column type (`char(n)`) does not conform, because it makes `"a"` and `"a  "` equal.

**F-ORD-3 (dates and other string-encoded scalars).** A `Date`-typed attribute encodes as ISO-8601 UTC with milliseconds (`toISOString()`), which is fixed-width, so F-ORD-1's code-point order on that text **is** chronological order and no separate rule is needed. Comparison is exact at the precision the literal grammar can express: a stored instant with sub-millisecond resolution is not `eq` to a millisecond literal unless the sub-millisecond part is zero, and a server must not round to make it match. The same reasoning covers any attribute whose JSON form is a fixed-width text encoding whose lexicographic order is the order intended — a zero-padded numeric code, say. Where it is not fixed-width, code-point order still applies and is still the profile's answer; it is the declaration's job to know that (`"9"` sorts after `"10"`).

**F-ORD-4 (literal unions are strings, not an enumeration).** An attribute declared `Schema.Literals(["draft", "published", "archived"])` is a JSON string, so its order is code-point order over the member names — `"archived"` < `"draft"` < `"published"` — **not** declaration order. Declaring `lt lte gt gte` on such an attribute is legal and means exactly that; declare only `eq ne in nin isnull` if alphabetical order is not what you want.

**F-ORD-5 (to-one relationship fields).** The value and the literal are both the related resource's `id`, a JSON string, compared under F-ORD-1/F-ORD-2. Ordering operators are not declarable on a relationship field ([§1.2](#12-fields)), so only equality and membership arise. A resource's own `type` is not compared: the target type is fixed by the relationship's declaration.

**F-ORD-6 (an explicit literal codec).** A declaration may supply its own literal codec (`Codec<Type, string>`) for the rare attribute whose JSON form is not a scalar ([§2.3](#23-literals-and-lists)). F-ORD-1 cannot describe such a field, so comparison is on that codec's **encoded string**, in code-point order, and the declaration owns whether that order means anything. This is the one place the profile's answer depends on a server's own definition, and it is opt-in.

**F-ORD-7.** Every order above is **total** on its domain: for a non-NULL value `V` and a literal `L`, exactly one of `V < L`, `V = L`, `V > L` holds. NaN and ±Infinity are not JSON values, so they cannot occur on either side; the literal grammar refuses them ([§6.6](#66-type-coercion-and-literals)) and a JSON:API document cannot carry them.

### 6.3 Truth tables

Below, `V` is `value(resource, field)` ([§6.4](#64-null) for what makes it NULL) and `L` is the node's literal, which is never NULL (**F-NULL-1**). `V < L` and `V = L` are F-ORD-1's relations.

#### 6.3.1 Comparison — `eq ne lt lte gt gte`

**F-CMP-1.** When `V` is NULL, **every** comparison is UNKNOWN. This is the rule implementations diverge on silently, and it is the one worth reading twice: `filter[status][ne]=done` does **not** match a resource whose `status` is NULL, and neither does `filter[status]=done`. Use `filter[status][isnull]=true` to name those resources, or an `OR` group to include them.

**F-CMP-2.** When `V` is not NULL, each operator is the two-valued result of its relation:

| Operator | `V` is NULL | `V < L` | `V = L` | `V > L` |
| -------- | ----------- | ------- | ------- | ------- |
| `eq`     | UNKNOWN     | FALSE   | TRUE    | FALSE   |
| `ne`     | UNKNOWN     | TRUE    | FALSE   | TRUE    |
| `lt`     | UNKNOWN     | TRUE    | FALSE   | FALSE   |
| `lte`    | UNKNOWN     | TRUE    | TRUE    | FALSE   |
| `gt`     | UNKNOWN     | FALSE   | FALSE   | TRUE    |
| `gte`    | UNKNOWN     | FALSE   | TRUE    | TRUE    |

**F-CMP-3.** `ne` is the complement of `eq` **only where `V` is not NULL**. `eq` and `ne` on the same field and literal are not a partition of the collection; the resources with a NULL `V` are in neither.

#### 6.3.2 Membership — `in`, `nin`

**F-IN-1.** `In(field, [L₁ … Lₙ])` is `eq(field, L₁) OR … OR eq(field, Lₙ)` under [§6.3.3](#633-connectives-and-or-not). The list is non-empty ([§1.1](#11-nodes)), so the degenerate case does not arise.

**F-IN-2.** `NotIn(field, values)` is `NOT In(field, values)` — the negation of F-IN-1, evaluated under F-NOT-1.

**F-IN-3.** Because a list can never contain NULL (**F-NULL-1**), the two readings of `nin` that differ in SQL — `NOT IN (…)` and the negation of `IN (…)` — **coincide here**, and F-IN-2 is both. This is not an accident of the tables: it is the reason `NULL` was excluded from the literal grammar. Expanded:

| Case                 | `in`    | `nin`   |
| -------------------- | ------- | ------- |
| `V` is NULL          | UNKNOWN | UNKNOWN |
| `V` equals some `Lᵢ` | TRUE    | FALSE   |
| `V` equals no `Lᵢ`   | FALSE   | TRUE    |

**F-IN-4.** The order and multiplicity of a list are meaningless: the codec sorts and deduplicates it ([§3.2](#32-normal-form)), and F-IN-1 is invariant under both. The canonical list order is code-point order on the _encoded_ items for every JSON type, including numbers — it is a syntactic rule for producing one spelling, and must not be mistaken for F-ORD-1's comparison order.

#### 6.3.3 Connectives — `and`, `or`, `not`

**F-LOGIC-1.** The connectives are Kleene's strong three-valued logic:

| `AND`       | TRUE    | FALSE | UNKNOWN |
| ----------- | ------- | ----- | ------- |
| **TRUE**    | TRUE    | FALSE | UNKNOWN |
| **FALSE**   | FALSE   | FALSE | FALSE   |
| **UNKNOWN** | UNKNOWN | FALSE | UNKNOWN |

| `OR`        | TRUE | FALSE   | UNKNOWN |
| ----------- | ---- | ------- | ------- |
| **TRUE**    | TRUE | TRUE    | TRUE    |
| **FALSE**   | TRUE | FALSE   | UNKNOWN |
| **UNKNOWN** | TRUE | UNKNOWN | UNKNOWN |

| `NOT` | TRUE  | FALSE | UNKNOWN |
| ----- | ----- | ----- | ------- |
|       | FALSE | TRUE  | UNKNOWN |

**F-AND-1.** `And(members)` is the fold of the `AND` table over the members; `Or(members)` the fold of the `OR` table. Both are associative and commutative on these tables, so the codec's reordering and deduplication of members ([§3.2](#32-normal-form)) never changes a result — including deduplication, since `x AND x = x` and `x OR x = x` hold in all three values.

**F-AND-2.** `And([])` is TRUE — it matches every resource. `Or([])` is FALSE — it matches none, so a collection filtered by it is `data: []`. These are the identities of the two folds, and both are expressible ([§2.4](#24-group-form)); neither is what an absent `filter` means, which is no constraint at all ([§6.7](#67-the-400-boundary)).

**F-NOT-1.** `Not(member)` is the `NOT` table applied to the member's value. It is an involution: `Not(Not(x))` and `x` are the same for all three values, so the codec's refusal to simplify a double negation ([§1.1](#11-nodes)) is a syntactic choice with no semantic content.

#### 6.3.4 The null test — `isnull`

**F-ISNULL-1.** `IsNull(field, negated: false)` is TRUE when `V` is NULL and FALSE otherwise. `IsNull(field, negated: true)` is TRUE when `V` is not NULL and FALSE otherwise.

**F-ISNULL-2.** `isnull` is **total**: it never evaluates to UNKNOWN, whatever `V` is. It is the only operator with that property, and the only way to name NULL at all.

**F-ISNULL-3.** Because of F-ISNULL-2, `IsNull(f, negated: true)` and `Not(IsNull(f, negated: false))` are exactly equivalent, for every resource. The redundancy is kept because interpreters emit `IS NOT NULL` directly and the shorthand names it ([§1.1](#11-nodes)).

**F-ISNULL-4.** `isnull` is declarable, and legal, on a field that can never be NULL. It is then a constant: `isnull=true` matches nothing, `isnull=false` matches everything. This is deliberate — `Filter.able()` declares the whole core, including `isnull`, on non-nullable attributes, and that must not be an error.

### 6.4 NULL

**F-NULL-1.** `NULL` is **never a literal**. There is no wire spelling for it, no AST node carries it as a value, and `isnull` is the only operator that names it. Every rule above may assume `L` is not NULL.

**F-NULL-2 (a `null` arriving in a literal position).** On the wire, every value is a string, so `null` cannot arrive: `filter[title]=null` is the four-character **string** `"null"`. What it means follows from [§6.6](#66-type-coercion-and-literals) and nothing else:

| Attribute's JSON type | `filter[f]=null`                           |
| --------------------- | ------------------------------------------ |
| string                | `eq` against the string `"null"`           |
| number, boolean       | **400**, `source.parameter` naming the key |

A tree built in memory can hold a `null` where a literal belongs; it is not a valid tree, and encoding it fails rather than producing a URL, with a message that names the field and points at `isnull`. Servers that accept a filter tree from anywhere but this codec must reject a `null` literal themselves.

**F-NULL-3.** A `NULL` value is never _produced_ by evaluation either: the three-valued result of a comparison against NULL is UNKNOWN ([F-CMP-1](#631-comparison-eq-ne-lt-lte-gt-gte)), which is a truth value, not a value of the field.

**F-NULL-4.** Three-valued logic is this profile's choice, not an inheritance. The reasoning: almost every server implementing it evaluates against a store that is already three-valued, so two-valued logic would require each of them to add compensation (`COALESCE`, `IS DISTINCT FROM`) at every comparison and would make the common case the one that needs care. The cost is F-CMP-3 — `eq` and `ne` do not partition — and it is paid explicitly rather than silently, since `isnull` gives the client the resources those two leave out.

### 6.5 Consequences

These follow from §6.1–§6.4. They are listed because each is a place implementations diverge, and each is directly testable.

**F-CONS-1.** `Or(eq(f, v), Not(eq(f, v)))` does **not** match every resource: where `f` is NULL both disjuncts are UNKNOWN and the fold is UNKNOWN. The law of excluded middle does not hold, and a filter's complement is `Or(Not(x), isnull(f))`-shaped, not `Not(x)`.

**F-CONS-2.** De Morgan holds in both directions: `Not(And(a, b))` ≡ `Or(Not(a), Not(b))` and `Not(Or(a, b))` ≡ `And(Not(a), Not(b))`, for all three values.

**F-CONS-3.** `Not(In(f, vs))` ≡ `NotIn(f, vs)`, by F-IN-2.

**F-CONS-4.** `Not(Not(x))` ≡ `x`, by F-NOT-1.

**F-CONS-5.** Filtering never changes the shape of a response, only its membership: an empty result is `200` with `data: []` ([§6.7](#67-the-400-boundary)), and `included`, full linkage and `meta`/`links` are unaffected.

**F-CONS-6.** `filter` constrains the **primary data** of the collection being fetched. It is not applied to `included` resources: those are exactly the ones full linkage requires for the primary data that matched. A client cannot filter an included set with this family.

**F-CONS-7.** Two URLs with the same canonical form (§3) match the same resources, for every resource — the canonical string is a function of the tree, and the tree is what §6 evaluates. The converse does not hold: distinct canonical strings may match identically (`And([])` and `isnull=false` on a non-nullable field, say). Canonical identity is syntactic.

### 6.6 Type coercion and literals

A literal reaches evaluation through two stages, both normative, both already enforced by the codec.

**F-COERCE-1 (wire string → JSON value).** After the escape grammar has been applied ([§2.3](#23-literals-and-lists)), each item is read as the attribute's JSON type:

| Attribute's JSON type | Accepted wire text | Rejected (400) |
| --- | --- | --- |
| **string** | any text, the empty string included | nothing at this stage |
| **number** | a strict decimal: `[+-]?(\d+(\.\d*)?\|\.\d+)([eE][+-]?\d+)?`, denoting a finite double | `""`, whitespace, `" 1"`, `0x10`, `1_000`, `NaN`, `Infinity`, `1e999` |
| **boolean** | exactly `true` or `false` | `TRUE`, `1`, `yes`, `""` |

The number grammar is deliberately narrower than JavaScript's `Number()`, which also accepts every entry in the right column. It is wider than JSON's own number grammar in three harmless ways — a leading `+`, leading zeros (`010`), and the `1.` and `.5` forms — each of which canonicalises away (F-COERCE-4).

**F-COERCE-2 (JSON value → the attribute's own type).** The value is then decoded by the attribute's schema, so every constraint the attribute carries applies to the literal: `Schema.Int` rejects `3.5`, `Schema.NonEmptyString` rejects `""`, `Schema.Literals([…])` rejects a non-member, `Schema.DateFromString` rejects text that is not a date, a brand is applied, a template literal is matched. A `Schema.NullOr(X)` attribute's literals are `X`'s: the `null` member is stripped, per F-NULL-1.

**F-COERCE-3.** Both stages fail as a **400** whose `source.parameter` names the offending key ([§7](#7-error-pointers)) — never as a silently non-matching filter. `filter[priceCents][gt]=abc` and `filter[status]=bogus` tell the client it asked something meaningless.

**F-COERCE-4 (canonicalisation is a coercion too).** A literal is re-encoded through the same schema, so the canonical string carries one spelling per value: `filter[age]=010` and `filter[age]=+1e1` both canonicalise to `filter[age]=10`, `filter[age]=-0` to `filter[age]=0`, and `filter[createdAt][gte]=2026-01-01` to the full `filter[createdAt][gte]=2026-01-01T00:00:00.000Z`. Two URLs that differ only in a literal's spelling therefore match the same resources **and** produce the same `self` link.

**F-COERCE-5.** The isnull operand is not a literal and does not go through F-COERCE-1: it is exactly `true` or `false` ([§2.2](#22-shorthand)), and anything else is a 400.

### 6.7 The 400 boundary

The line between "this filter is malformed" and "this filter matches nothing" is part of the profile: a client must be able to tell a mistake from an empty result.

| Condition | Response |
| --- | --- |
| a field the resource does not declare filterable | 400, `source.parameter` names the key |
| an operator the field does not declare (or one outside the core) | 400 |
| a literal that fails F-COERCE-1 or F-COERCE-2 | 400 |
| any structural fault of §2 (malformed key, repeated key, cycle, arity) | 400 |
| a well-formed filter no resource satisfies | **200**, `data: []` |
| a well-formed filter on a resource whose attribute is absent or NULL | **200**; that resource simply does not match |

**F-ERR-1.** Whether a field is filterable is a property of the resource _definition_, so the 400 is decided before any data is read and is the same for every client and every collection state.

**F-ERR-2.** An empty result is never a 404. A 404 says the collection does not exist; a filter that excludes everything says it does and is empty.

**F-ERR-3.** An absent `filter` is not `And([])`. It is no constraint at all, and a server must not synthesise a node for it — the decoded query has no `filter` member ([§8](#8-interaction-with-the-rest-of-queryschema)).

**F-ERR-4.** A server that refuses an otherwise-valid filter — because the tree is too large, too deeply nested, or too costly — must answer 400 (or 403 where the refusal is an authorization decision) and must **not** ignore the filter, apply part of it, or return a partial result. Silently widening a result set is the one non-conformance a client cannot detect.

**F-ERR-5.** Filtering is applied to what the client is already permitted to see. A filter never widens a result set beyond the server's authorization decision, and a resource excluded by authorization is not observable through a filter's truth value.

### 6.8 What this profile does not define

Stated so an implementer knows where the profile stops, rather than guessing.

- **`sort` ordering, and where NULLs sort.** §6 governs `filter`. `sort` is its own family, and its order is [§10](#10-sort-order)'s — which reuses this section's comparison domain, so `sort=title` and `filter[title][gt]=…` agree. (Before #167 this bullet left the collation and NULL placement unpinned, and only recommended F-ORD-1's order.)
- **Pagination and stability.** Which page a matching resource lands on is the `page` family's and the server's business. Whether an order is stable across requests is [S-TIE-1](#105-ties-and-stability)'s, a SHOULD.
- **Cost.** The profile puts no bound on tree size or nesting; F-ERR-4 says only how to refuse one.
- **Where filtering happens.** Any implementation strategy conforms as long as F-EVAL-3 holds for every resource.

### 6.9 Decisions recorded

**Three-valued, and ours.** Recorded in F-NULL-4. Earlier revisions of this note called the semantics "Postgres-normative" and pointed at another project's ADR for the tables. The choice was reasonable; the citation was not a specification, and a third-party implementer had nowhere to look. §6 is the replacement, and it cites nothing.

**The profile URI stays `v1`**, for §6 and again for §10. See [§5](#5-profile-uri).

**No reference evaluator ships.** Considered, and declined for this version:

- The package is the JSON:API layer. Every export is a schema, a codec or an endpoint constructor; nothing in it has ever evaluated data, and a server evaluates against its store — SQL, an index, a document database — not against a JavaScript object graph. A shipped evaluator would be an oracle no deployment runs, and a second implementation of §6 to keep honest.
- The rules above are written so that one is easy: every operator is a total function of the node and `value(resource, field)`, and `value` is read from the resource's JSON representation, which a conformance harness already has. An evaluator is a short fold over the AST and the tables in §6.3.
- An executable oracle belongs where it can run against the thing that actually has to conform — a **server** — which is the conformance kit, [#120](https://github.com/thomasfosterau/effect-jsonapi/issues/120). Shipping it here would also force an API decision the kit should make instead: F-ORD-1's comparison domain is derived internally from an attribute's encoded form and is not part of `Resource.filterable`'s public shape, and an evaluator would have to expose it.
- Revisited in [#161](https://github.com/thomasfosterau/effect-jsonapi/issues/161) and kept. The kit builds its own **internal** oracle (`src/internal/conformance/semantics.ts`); nothing is exported from `Filter`, and the comparison domain stays internal: the kit infers F-ORD-1's domain from the JSON type of the values it observes in the unfiltered collection, which is the domain F-ORD-1 defines comparison on, so `Resource.filterable`'s public shape is unchanged.

**§6 is tested where it is implemented.** The rules the codec enforces — F-NULL-1, F-NULL-2, F-COERCE-1 to F-COERCE-5, F-ORD-1's domain restriction, F-ERR-1 to F-ERR-3 — are tested in `src/Query.filter.test.ts` and `src/Resource.filter.test.ts`. The evaluation rules — `F-EVAL-*`, `F-CMP-*`, `F-IN-*`, `F-LOGIC-*`, `F-ISNULL-*`, `F-CONS-*` — are not behaviour this package has, so what is tested here is that the tables are coherent and that the corollaries in §6.5 follow from them (`src/Filter.semantics.test.ts`, which checks the tables against the conformance kit's own fold, so the oracle and the text cannot drift apart). The conformance kit executes them against a _server_: `profile/filter/evaluation` fetches a collection unfiltered, evaluates filter trees over each resource's JSON with that fold, and names every resource the filtered request wrongly included or excluded. Its trees are the discriminating ones — `ne` and the ordering operators over NULL (F-CMP-1), `nin` over NULL (F-IN-2, F-IN-3), `isnull` (F-ISNULL-1, F-ISNULL-2), excluded middle (F-CONS-1), `lt` / `lte` / `gt` / `gte` at a pivot that splits an attribute never NULL (F-CMP-2, F-ORD-1) and `isnull=true` on it (F-ISNULL-4), equality, membership and `isnull` on a to-one relationship valued by its related id (F-EVAL-4, F-ORD-5), a filter beside a sparse fieldset that leaves its field out (F-EVAL-6), and the empty groups (F-AND-2) — and it says so, rather than passing, when the sample holds no field to build one family on. The GitHub example's `GET /issues` speaks the grammar, so the rule runs against a real handler in CI.

## 7. Error pointers

Every rejection is one JSON:API error object with `status: "400"` and `source: { parameter: "<flat key>" }`, where the flat key is the bracketed wire key as received (`filter[age][gt]`, `filter[c][condition][operator]`). The codec raises each failure as a `SchemaIssue.Pointer([flatKey], issue)` — several failing keys as a `Composite` of them — so the issue path names the key, and the `SchemaErrors` middleware (`Middleware.schemaErrorDocument`) renders one error object per issue leaf: `detail` is the issue's message and `source` is derived from the part that failed and the leaf's path — `source.parameter` for a query (a nested path is re-bracketed, `["page", "limit"]` → `page[limit]`, so the grammar's single-segment keys pass through unchanged) or path parameter, `source.header` for a header, `source.pointer` (a JSON Pointer) for a body. When no source can be derived the document is the single-error one of before. HttpApi decodes each request part with the default parse options (`errors: "first"`), so outside the `filter` family — whose codec composites every offending key itself — a part yields one error object. The documents are tested end to end, not only the thrown issues.

Unknown field, undeclared operator and bad literal are three distinct failures with three distinct `detail` strings and the same `source.parameter` shape (#84, #86 acceptance).

## 8. Interaction with the rest of `Query.schema`

- `filter: true` turns the grammar on, over the resource's declaration (#84). Passing a field map (`filter: { q: Schema.String }`) keeps today's open, per-key escape hatch unchanged (README, _Query parameters_); an endpoint uses one or the other. Heterogeneous endpoints (several resources) keep the escape hatch in phase 1.
- Default is off: an undeclared attribute is not filterable, matching `include` / `fields` / `sort`.
- `sort: true` keeps meaning "every attribute"; the declared sortable set — the attributes piped through `Sort.able()` (or `Resource.attribute(schema, { sort: true })`) — is an allow-list a consumer passes explicitly (`sort: Resource.sortable(Article)`), so no existing endpoint changes behaviour.
- The flat-key reshaper (`src/internal/codecs.ts`'s `nest`) handles one bracket level. `filter[*]` keys are routed to the grammar (`src/internal/filter.ts`) ahead of it, so `page[*]` and `fields[*]` are untouched. On the wire side of `Query.schema` they are an index-signature rest (`Query.FilterRest`) of the flat struct, since the group form admits any id.
- Literal codecs run synchronously in the codec; a codec that needs an asynchronous service fails decoding rather than being awaited.

## 9. Reviewed against usage

legation#148's table (23 filter sites across four example apps: 16 `eq`, 2 `in`, ids and one boolean, no NULL filters, no traversal) is fully expressible in bare shorthand, unchanged from what those sites emit today (`filter[status]=open`, `filter[priority]=1,2`). Legation's current encoder drops `ne` / `gt` / `or` / `not` / `eq null` (`packages/jsonapi/src/JsonApiQuery.ts:46-58`); under this grammar all of them have an exact form (`eq null` becomes `isnull=true`), which is what lets L7 delete `safeFilters`.

## 10. Sort order

**Normative.** This section defines what `?sort=` _orders by_: which value of a resource is compared, in what order, where NULL lands, how several fields combine and how ties are broken. JSON:API §Sorting fixes the syntax — a comma-separated list of fields, each ascending unless prefixed with `-` — and leaves the order itself to the server. This is the profile's answer, written so that two servers built on this library, or one built on it and one that is not, list `?sort=name` identically.

It lives in this profile, rather than in a profile of its own, because it is the same ordering model: `sort` reuses [§6.2](#62-comparison-domains)'s comparison domain instead of defining a second one, so `sort=title` and `filter[title][gt]=…` agree about which titles come first ([S-ORD-1](#103-order)). Its rules carry `S-…` identifiers, stable on the same terms as §6's, and each is checkable from the wire.

### 10.1 Scope

**S-SCOPE-1.** §10 applies to every endpoint that answers a **resource collection** as primary data and supports `sort` — a primary collection (`GET /articles`) and a to-many related endpoint (`GET /articles/1/comments`) alike — whether or not that endpoint speaks the filter grammar. A single-resource endpoint has nothing to order; JSON:API's own rule for `sort` there (a 400) is unchanged.

**S-SCOPE-2.** A relationship endpoint (`GET /articles/1/relationships/comments`) answers linkage, whose identifiers carry no attribute to sort on. This package declares no `sort` on one. A server that supports `sort` there must list the identifiers in the order its related endpoint lists the same resources under the same `sort`.

**S-SCOPE-3.** `sort` orders the **primary data** only. The order of `included` is not defined, by JSON:API or by this profile, and a client must not read one into it — as [F-CONS-6](#65-consequences) keeps `filter` off `included`.

**S-SCOPE-4.** The **canonical order** a paginated relationship declares (`Relationship.paginated(ref, { order })`, in the `{ field, direction }` terms `?sort=` decodes into) is an order in this section's sense: each term means exactly what the same term would mean in a `sort`, under every rule below.

### 10.2 The sort key

**S-KEY-1 (the value of a sort field).** A sort field is a declared attribute, or `id`. Its value on one resource is read exactly as [F-EVAL-4](#61-the-evaluation-model) reads a filter field's: the attribute's value in the resource's JSON representation, NULL when the member is JSON `null` **or** absent (F-EVAL-5), read from the **complete** representation whatever `fields[TYPE]` asked for (F-EVAL-6); `id` is the resource's `id`, a JSON string. A dotted path (`author.name`), which JSON:API permits a server to support, is relationship traversal and is not defined by this profile ([§4](#4-the-operator-core-is-closed)).

**S-KEY-2 (fields with no order).** F-ORD-1 orders JSON strings, numbers and booleans, one type at a time. A field whose values in a collection are not all one JSON scalar type besides NULL — a struct, an array, or a union of a string and a number — has no order under this profile. A server may refuse it (a 400, as for any field it does not support) or order it as it likes; a declaration that makes such a field sortable owns what that order means, as [F-ORD-6](#62-comparison-domains) owns an explicit literal codec.

### 10.3 Order

**S-ORD-1 (the domain rule, reused).** `?sort=f` lists the collection in **ascending** order of `f`'s values under [F-ORD-1](#62-comparison-domains): numeric order for a JSON number (`-0` and `0` tie), code-point order for a JSON string, `false` before `true`. Everything §6.2 says of the domain holds for `sort` unchanged — F-ORD-2 (no case folding, no locale or ICU collation, no Unicode normalisation: a store sorting under a locale collation must force binary comparison, `COLLATE "C"` in Postgres, `COLLATE BINARY` in SQLite), F-ORD-3 (a `Date` is its fixed-width ISO-8601 UTC text, so text order is instant order), F-ORD-4 (a literal union sorts alphabetically, not in declaration order) and F-ORD-7 (the order is total on non-NULL values). The consequence the reuse buys: for non-NULL values, a resource listed after another under `sort=f` is never one that `filter[f][lt]=<the other's value>` matches.

**S-ORD-2 (descending).** `?sort=-f` lists the collection in **exactly the reverse** of S-ORD-1's order, NULL placement included.

**S-ORD-3 (NULL).** NULL sorts **after every value** ascending, and so — by S-ORD-2 — **before every value** descending. Every NULL ties with every other NULL. Sorting is two-valued even though [§6.3](#63-truth-tables) is not: a comparison against NULL is UNKNOWN to a filter, but an order must put each resource somewhere, so for ordering only, NULL is one value, greater than every other.

**S-ORD-4 (ties).** Two resources tie on a field when their values are equal under F-ORD-1 (identical code points, numeric equality, the same boolean) or are both NULL. A tie is resolved by the next sort field ([§10.4](#104-several-fields)), and after the last one by [S-TIE-1](#105-ties-and-stability).

### 10.4 Several fields

**S-MULTI-1 (lexicographic).** `?sort=f₁,f₂,…,fₙ` orders by `f₁`; resources that tie on `f₁` (S-ORD-4) are ordered by `f₂`; and so on. Each term carries its own direction, so `?sort=-createdAt,title` is newest first, and alphabetical within one instant.

**S-MULTI-2.** A term only ever breaks ties the terms before it left; it never reorders resources an earlier term already ordered. So a later term naming a field an earlier one named (`sort=a,-a`) changes nothing, in either direction.

### 10.5 Ties and stability

**S-TIE-1 (SHOULD).** A server **SHOULD** break every tie left after the last sort field by `id`, so the order is **total** over the collection and the same on every request. Without it, the relative order of resources that tie on every sort field is unspecified and may differ between two identical requests — which silently breaks offset pagination over that order, repeating a resource on two pages or skipping one.

**S-TIE-2.** The tiebreak is a fixed order on `id`, the same for every request. Ascending code-point order on the `id` string — what `?sort=…,id` means under S-ORD-1 — is the recommended one. A server whose ids are integers written as strings may order them numerically instead, since `"10"` before `"9"` is correct under S-ORD-1 but surprising; either is total, which is what S-TIE-1 asks for.

**S-TIE-3.** When `id` is itself a sort field, the order is already total and S-TIE-1 adds nothing.

### 10.6 With `filter` and `page`

**S-PAGE-1.** The order is a property of the whole collection being fetched — after `filter` has decided its membership ([F-EVAL-3](#61-the-evaluation-model)), before `page` cuts it into pages. Every resource on a page follows every resource on the page before it, so a client walking `next` through `?sort=f` sees one sequence in S-ORD order, not a sorted page at a time.

**S-PAGE-2.** Sorting never changes membership: `?sort=f` and no `sort` at all list the same resources, and a field NULL on every resource is still a field the collection can be sorted by.

### 10.7 What §10 does not define

- **The order without `sort`.** JSON:API lets a server apply a default order when `sort` is absent; this profile does not define one, except a paginated relationship's declared canonical order (S-SCOPE-4).
- **Which fields are sortable.** That is the endpoint's declaration (`Sort.able`, `Resource.sortable`); a field it does not support is a 400 under JSON:API §Sorting.
- **Dotted sort paths** (S-KEY-1) and **fields with no order** (S-KEY-2).

### 10.8 Decisions recorded

**One ordering model, not two (#167).** `sort` could have had its own collation. Reusing F-ORD-1 makes `sort` checkable from the wire exactly as it made `filter` checkable — the conformance kit reads each value off the response and needs no fixture — and it means a client never has to know which of two orders a server meant. The cost is F-ORD-2's: a server whose store collates text by locale must force binary comparison for `sort` too, as it already must for `filter`. §6.8 had already _recommended_ this order for `sort`; §10 makes it the rule.

**NULLs last ascending.** SQL leaves NULL placement to `NULLS FIRST` / `NULLS LAST`, and engines disagree by default: Postgres and Oracle put NULLs last ascending, SQLite and MySQL first. The profile picks last, for three reasons: it is the Postgres default, which [§6](#6-semantics)'s semantics are already closest to; with S-ORD-2 it makes NULL a single greatest value, so descending is the exact reverse of ascending with no second rule; and it puts resources with no value at the end of an ascending listing, after the ones a client asked to see ordered. A SQLite or MySQL store says `NULLS LAST` (SQLite 3.30 and later) or sorts on `f IS NULL` first; an IndexedDB index omits records whose key is absent, so a store built on one must merge them back in at the end.

**The `id` tiebreak is a SHOULD.** A MUST would make every server that orders by its storage's row order — and every store where an extra index on `id` is costly — non-conforming over collections in which no two resources ever tie. A SHOULD names the defect, which [#166](https://github.com/thomasfosterau/effect-jsonapi/issues/166)'s pagination walk already observes as an unstable order and reports as not decided rather than failed, and leaves the cost to the server.

**Related endpoints are in, relationship endpoints are defined but not checked.** A to-many related endpoint answers a resource collection and is where `Group.resource` derives `sort`, so it is held to §10 like any primary collection (S-SCOPE-1). A relationship endpoint answers identifiers that carry no field to read an order off; S-SCOPE-2 defines what `sort` there would mean, and nothing in this package declares it.

**A section of this profile, under `v1`.** See [§5](#5-profile-uri).
