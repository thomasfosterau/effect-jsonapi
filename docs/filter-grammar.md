# Filter grammar

The specification of the `filter` query family. Tracks [#83](https://github.com/thomasfosterau/effect-jsonapi/issues/83)
(epic [#82](https://github.com/thomasfosterau/effect-jsonapi/issues/82)) and
[#116](https://github.com/thomasfosterau/effect-jsonapi/issues/116).

This document **is** the profile published at
`https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1`, and it is complete:
the AST, the operator core, the URL surface, the canonical encoding, the
[semantics](#6-semantics) and the profile URI. A third-party implementer needs nothing but this
document to answer `filter[status][eq]=draft` the same way this package does — which is the whole
point of shipping a profile rather than an implementation-defined `filter`.

**Status:** implemented. [#84](https://github.com/thomasfosterau/effect-jsonapi/issues/84)
(per-attribute declaration, `Resource.filterable`) and
[#86](https://github.com/thomasfosterau/effect-jsonapi/issues/86) (the AST `Filter.Ast`, the codec
`Query.Filter` / `filter: true`, the error pointers) are in the package;
[#85](https://github.com/thomasfosterau/effect-jsonapi/issues/85) (the canonical `self` string) follows.

## 0. Scope and decisions already taken

Settled in #82, not reopened here:

- Operator core `eq ne lt lte gt gte in nin isnull` plus `and or not` groups. No relationship
  traversal, no pattern matching, no text search.
- Shorthand desugars into the group form. `filter[f]=v` stays `eq`, `filter[f]=a,b` stays `in`.
- Literals are typed by the attribute schema. `NULL` is not a literal; use `isnull`.
- Semantics are three-valued. #82 settled that much and left the rules unwritten;
  [§6](#6-semantics) writes them, which
  [#116](https://github.com/thomasfosterau/effect-jsonapi/issues/116) completed.
- Ships as a documented profile URI, not an `ext` extension.

Two things below go further than the issue text and are called out where they occur:
[§1.2](#12-fields) admits to-one relationship names as fields (decided with #84), and
[§7](#7-error-pointers) records how the error middleware was extended so `source.parameter` is
emitted.

## 1. The AST

The AST is an **initial encoding**: plain data, an Effect `Schema` union, no methods. Every
consumer pattern-matches on it: the URL codec here, and whatever interprets a tree downstream — SQL,
an in-memory predicate, an IndexedDB cursor — under the rules of [§6](#6-semantics).

### 1.1 Nodes

```ts
type Ast<Field extends string, Literal> =
  | {
      readonly _tag: "Compare"
      readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"
      readonly field: Field
      readonly value: Literal
    }
  | { readonly _tag: "In"; readonly field: Field; readonly values: NonEmptyReadonlyArray<Literal> }
  | { readonly _tag: "NotIn"; readonly field: Field; readonly values: NonEmptyReadonlyArray<Literal> }
  | { readonly _tag: "IsNull"; readonly field: Field; readonly negated: boolean }
  | { readonly _tag: "And"; readonly members: ReadonlyArray<Ast<Field, Literal>> }
  | { readonly _tag: "Or"; readonly members: ReadonlyArray<Ast<Field, Literal>> }
  | { readonly _tag: "Not"; readonly member: Ast<Field, Literal> }
```

Rules the schema enforces:

- `value` and `values` are **typed literals**: the attribute's decoded type (`number`, `Date`, a
  string-literal union, …), never a raw string and never `null`. The literal type therefore differs
  per field; at the type level the union is `Compare<"age", number> | Compare<"title", string> | …`
  over the declared fields, and `Query.Filter(R).Type` narrows `field` to a literal union of the
  declared names (#84).
- `In` / `NotIn` lists are **non-empty**. An empty list has no URL form (see [§2.3](#23-literals-and-lists)),
  and a codec that must be total cannot carry a node it cannot encode. A producer holding an empty
  list has to decide what it meant before it reaches this AST — drop the condition, or write the
  `Or([])` that says "nothing matches" ([§6.2](#62-the-logic-is-three-valued)).
- `IsNull.negated: true` is `IS NOT NULL`. `NotIn` and negated `IsNull` are redundant with `Not`
  but are kept because interpreters emit them directly (`NOT IN`, `IS NOT NULL`) and because the
  shorthand surface names them (`nin`, `isnull=false`).
- `And` / `Or` members are a **set**, not a sequence: order carries no meaning and the codec sorts
  them ([§3.2](#32-normal-form)). `And([])` is "true", `Or([])` is "false". Both are representable
  ([§2.4](#24-group-form)); neither is what an absent `filter` decodes to (absent is absent).
- `Not` takes exactly one member of any kind. `Not(Not(x))` is a legal tree and encodes as two
  nested `NOT` groups; the codec does not simplify it.

The decoded `filter` is **one root node**. Shorthand with several keys decodes to a root `And`;
shorthand with one key decodes to that bare condition ([§2.2](#22-shorthand)).

### 1.2 Fields

A field is a **declared name on the primary resource** (#84). No dotted paths, no traversal.

**Decision (accepted, #84).** Fields are the resource's declared attributes
(`schema.pipe(Filter.able(...))`, or the `Resource.attribute(schema, { filter })` sugar for it)
**plus its declared to-one relationship names**
(`Relationship.one(ref, { filter })` / `Relationship.optional(ref, { filter })`), the latter valued
by the related resource's id and admitting `eq ne in nin isnull` only — ordering operators make no
sense for an id, and declaring one is a definition-time error. This is not traversal: there is no
path and the literal is the related id, decoded through the target's `Id` schema. It keeps the
README's canonical `filter[author]=9`, `examples/northwind`'s `filter[category]` / `filter[customer]`
/ `filter[manager]` endpoints and the JSON:API recommendation `GET /comments?filter[post]=1`
expressible without exposing foreign keys as attributes, and it covers the empirical table in
legation#148 (16 `eq`, values are ids), which is mostly foreign keys. To-many relationships are not
fields. "Attribute" below reads as "declared field".

### 1.3 What the AST does not carry

The AST is data. Nothing about evaluation is stored in a node: there are no methods, no truth
values, no collation. What a tree _means_ is [§6](#6-semantics) — a property of the profile, not of
the data structure — so an interpreter targeting SQL, IndexedDB or plain records reads §6 and
pattern-matches on the nodes.

Two facts are fixed in §1 rather than §6 because the _codec_ needs them, not just an interpreter:
literals are typed by the attribute schema, and `NULL` is not a literal.

## 2. Surface syntax

Two forms, one AST. Every `filter[...]` key is classified by its bracket depth:

| Segments                                  | Form                                  |
| ----------------------------------------- | ------------------------------------- |
| `filter[f]`                               | shorthand, bare                       |
| `filter[f][op]`                           | shorthand, explicit operator          |
| `filter[id][group][…]` / `[condition][…]` | group form                            |
| anything else                             | 400, `source.parameter` names the key |

A repeated key (`filter[a]=1&filter[a]=2`, which `UrlParams.toRecord` surfaces as an array) is a 400. Only `include` is repeatable in this library.

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

The set is **closed** ([§4](#4-the-operator-core-is-closed)). An operator outside the attribute's
declared set, or a name not in this table, is a 400.

### 2.2 Shorthand

- `filter[f]=v` → `Compare { op: "eq", field: f, value: v }` when `v` contains no unescaped comma.
- `filter[f]=a,b` → `In { field: f, values: [a, b] }` when it contains one or more.
- `filter[f][op]=v` → the node for `op` ([§2.1](#21-operators)).
- `filter[f][isnull]=true` → `IsNull { negated: false }`; `=false` → `negated: true`. Any other
  value is a 400.

Each shorthand key is one condition at the **root**. One key decodes to that condition; several
decode to `And([...])`. A `(field, operator)` pair has at most one key in shorthand (`filter[f]=v`
and `filter[f][eq]=w` are two keys and both decode, but a third `eq` on `f` has nowhere to go), so
`age gt 18 AND age gt 20` needs the group form.

Shorthand is the desugared spelling of the group form: `filter[age][gt]=18` means exactly
`filter[c][condition][path]=age&filter[c][condition][operator]=gt&filter[c][condition][value]=18`.

### 2.3 Literals and lists

Every literal position (a bare value, an explicit-operator value, a group-form `value`) is written
in one **literal grammar**:

- `\,` is a literal comma, `\\` is a literal backslash.
- A backslash followed by anything else is malformed → 400.
- In a **list position** (`filter[f]=…`, `[in]`, `[nin]`, and group-form `value` for those
  operators) unescaped commas separate items. In a **scalar position** an unescaped comma is a 400.
- The empty string is a legal literal (`filter[title]=` is `eq ""` on a string attribute; on a
  number attribute it fails literal decoding). There is no spelling for an empty list, which is why
  `In` / `NotIn` are non-empty.

After unescaping, each item is decoded by the attribute's **literal codec**, derived from its
schema (#84):

| Attribute encoded form (JSON) | Wire string accepted                | Decoded literal      |
| ----------------------------- | ----------------------------------- | -------------------- |
| `string`                      | the string itself                   | via attribute schema |
| `number`                      | a finite decimal, `Number()`-strict | via attribute schema |
| `boolean`                     | `true` \| `false`                   | via attribute schema |
| `X \| null` (`Schema.NullOr`) | as `X`; `null` is never a literal   | via `X`              |

`DateFromString` is a `string` on the wire, so `filter[createdAt][gte]=2026-01-01T00:00:00.000Z`
decodes to a `Date` and re-encodes via the attribute's own encoder (`toISOString()`). ISO-8601 UTC
text sorts chronologically in code-point order, which is what makes `Date` an ordered kind in
[§6.6](#66-comparison). An attribute whose encoded form is not one of these
(a struct, an array) cannot be declared filterable; the declaration may supply an explicit literal
codec (`Codec<Type, string>`) for the rare case.

Because literals go through the attribute schema, `filter[priceCents][gt]=abc` and
`filter[status]=bogus` (on a literal-union attribute) are 400s with `source.parameter` naming the
key, not silent no-matches.

### 2.4 Group form

Drupal-style, for anything shorthand cannot say: `OR`, `NOT`, nesting, or two conditions with the
same field and operator. Keys are `filter[<id>][group][<member>]` and
`filter[<id>][condition][<member>]`; `<id>` is any string without `[`, `]` or `,` and is **not part
of the AST** (ids only wire members to groups).

| Key                              | Values                                           | Notes                                      |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| `filter[g][group][conjunction]`  | `AND` \| `OR` \| `NOT`                           | required; `NOT` must have exactly 1 member |
| `filter[g][group][memberOf]`     | a group id                                       | absent → root                              |
| `filter[c][condition][path]`     | a declared field                                 | required                                   |
| `filter[c][condition][operator]` | an operator                                      | required; no default                       |
| `filter[c][condition][value]`    | literal or list ([§2.3](#23-literals-and-lists)) | required (`true`/`false` for `isnull`)     |
| `filter[c][condition][memberOf]` | a group id                                       | absent → root                              |

Decoding:

- A node is a group or a condition, never both; an id used for both is a 400.
- `memberOf` must name a declared group; a cycle or an unknown parent is a 400.
- Root members are every group or condition (shorthand keys included) without `memberOf`. One root
  member is the root; several become an implicit root `And`.
- A group with no members is `And([])` / `Or([])`. A `NOT` group with zero or more than one member
  is a 400.
- Mixing shorthand and group keys in one URL is allowed; the shorthand keys are simply root
  conditions.

Every 400 carries `source.parameter` set to the flat key that failed
(`filter[c][condition][operator]`, say); a structural failure (a dangling `memberOf`, a cycle) points
at the `memberOf` key that names the missing target (for a cycle, the first cycle member's in input
order); a missing required member points at the key that is missing
(`filter[c][condition][operator]` when a condition has no operator); an id used as both a group and
a condition points at the first key of the second kind; a `NOT` with the wrong arity at its
`conjunction` key.

## 3. Canonical encoding

The canonical string is what `self` links carry ([#85](https://github.com/thomasfosterau/effect-jsonapi/issues/85)),
and it is what anything keying on a filter — an HTTP cache tag, a stored query, a client's record of
what it has already fetched — can use as that filter's identity. So it must be a **function of the
AST alone**: two URLs that decode to the same tree canonicalise to the same bytes, whatever their
key order, ids, escaping or `[eq]`/bare spelling.

### 3.1 Which form the encoder emits

Shorthand is emitted when, and only when, it decodes back to the same tree:

- The root is a single `Compare` / `In` / `NotIn` / `IsNull`, **or**
- the root is an `And` with two or more members, all of them conditions, whose `(field, operator)`
  pairs are pairwise distinct.

Everything else (any `Or` or `Not`, any nested group, an `And` with one member or with a repeated
`(field, operator)` pair, a bare `And([])`) is emitted in the group form. So is the one case where
distinct `(field, operator)` pairs would still share a shorthand key: an `eq` and a two-or-more-value
`In` on the same field are both written bare (`filter[f]=…`), so an `And` holding both takes the
group form — the test is that the shorthand keys are pairwise distinct. `And` with one member and
that member on its own are different trees and get different strings; `decode ∘ encode` is
identity.

Within shorthand:

- `eq` is written bare (`filter[f]=v`), never `[eq]`.
- `In` with two or more values is written bare (`filter[f]=a,b`); `In` with one value is
  `filter[f][in]=v` (bare would decode as `eq`).
- Every other operator is explicit.

### 3.2 Normal form

Decoding normalises; encoding assumes normal form. A tree is in normal form when:

- `In` / `NotIn` values are sorted by their **encoded** wire string (code-point order) and
  deduplicated.
- `And` / `Or` members are sorted by the **node order** below, and deduplicated.

The node order is total, id-free and structural:

1. Conditions sort before groups.
2. Conditions compare by `field`, then `operator` (as text), then the encoded value list (items
   joined by `,` after escaping), each code-point-wise.
3. Groups compare by conjunction as text (`AND` < `NOT` < `OR`), then by their (already sorted)
   members pairwise under this same order, a shorter member list sorting first on a tie.

`decode` always returns a normal-form tree, so the round-trip invariants are:

```
decode(encode(x)) == x                   for every x in normal form
encode(decode(u)) == canonical(u)        for every accepted URL u
decode(canonical(u)) == decode(u)
```

(A generated tree is normalised before the first check; the generator in #86 does this.)

### 3.3 Key order and ids

The canonical form is an ordered list of `(key, value)` pairs. Percent-encoding, bracket escaping
and joining with `&` are `Query.canonical`'s job (#85) and identical for every family: it places
the `filter[*]` pairs, in exactly this order, between `fields[*]` and `sort`, and serialises with
`Query.serialise` (RFC 3986 percent-encoding via `encodeURIComponent`, `[` / `]` left readable in
keys, so `\,` is `%5C%2C` and a list's separating comma `%2C`).

- **Shorthand:** pairs sorted by key, code-point order. Because `filter[age]` sorts before
  `filter[age][gt]` and operator names are compared as text, this is "by field, then operator"
  without a lookup table.
- **Group form:** ids are assigned by the encoder in pre-order over the normal-form tree, groups as
  `g0, g1, …` and conditions as `c0, c1, …`, and pairs are emitted in that traversal order, each
  node's members in the fixed order `conjunction, memberOf` / `path, operator, value, memberOf`.
  Ids are therefore also a function of the tree.
- **Values:** literals are re-encoded through the attribute schema and the literal grammar, so
  `filter[limit]=010` canonicalises to `filter[limit]=10` and a date to its ISO form.

### 3.4 Worked examples

Each operator, shorthand and canonical:

| URL                                 | AST                                                           |
| ----------------------------------- | ------------------------------------------------------------- |
| `filter[status]=open`               | `Compare { op: "eq", field: "status", value: "open" }`        |
| `filter[status][ne]=done`           | `Compare { op: "ne", … }`                                     |
| `filter[age][lt]=18`                | `Compare { op: "lt", field: "age", value: 18 }`               |
| `filter[age][lte]=18`               | `Compare { op: "lte", … }`                                    |
| `filter[age][gt]=18`                | `Compare { op: "gt", … }`                                     |
| `filter[age][gte]=18`               | `Compare { op: "gte", … }`                                    |
| `filter[priority]=1,2`              | `In { field: "priority", values: [1, 2] }`                    |
| `filter[priority][in]=1`            | `In { values: [1] }`                                          |
| `filter[status][nin]=archived,done` | `NotIn { values: ["archived", "done"] }`                      |
| `filter[deletedAt][isnull]=true`    | `IsNull { field: "deletedAt", negated: false }`               |
| `filter[deletedAt][isnull]=false`   | `IsNull { negated: true }`                                    |
| `filter[title]=Hello\, world`       | `Compare { op: "eq", field: "title", value: "Hello, world" }` |

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

and canonicalises to the string below: ids reassigned in pre-order; within each `AND` the `age`
condition sorts before `status`; and the `gt` group sorts before the `lte` group because both are
`AND`, their first members tie on `age`, and `gt` < `lte` as text.

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

`eq ne lt lte gt gte in nin isnull` and `and or not`. Nothing else decodes, and #84's declaration
cannot name anything else. Excluded, with the reason each has no portable Postgres / SQLite / JS /
IndexedDB semantics:

| Excluded                                 | Why                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `like` / `contains` / `startswith`       | `LIKE` escaping and case rules differ between Postgres and SQLite; IndexedDB has no substring index. |
| case-insensitive match (`ilike`, `ieq`)  | Case folding is locale- and collation-dependent; [§6.6](#66-comparison) fixes code-point order only. |
| full-text search                         | Tokenisation, stemming and ranking are engine-specific and non-deterministic across targets.         |
| array / JSON operators (`@>`, `?`, `->`) | No SQLite or IndexedDB equivalent; literals would stop being scalars typed by the attribute.         |
| regular expressions                      | Three incompatible regex dialects; unbounded evaluation cost.                                        |
| relationship traversal (`author.name`)   | An `EXISTS` a client authors: unbounded evaluation cost and a read surface over another collection.  |
| `between`                                | Sugar for `gte AND lte`; a second spelling would break canonical identity.                           |

Adding an operator is a new grammar version and a new profile URI ([§5](#5-profile-uri)).

## 5. Profile URI

The grammar is a JSON:API **profile**, not an `ext`: it constrains how a server interprets
`filter[*]`, which the spec leaves to the implementation, and changes nothing about document
structure. Servers advertise it on the media type of responses to endpoints that implement it:

```
Content-Type: application/vnd.api+json; profile="https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1"
```

- The URI is exported as a constant (`Filter.PROFILE_URI`, also `Query.FILTER_PROFILE_URI`) and is
  a version of this document. `v1` is this note; an incompatible change (a new operator, a changed
  canonical rule, a changed answer in [§6](#6-semantics)) is `v2`.

**Decision (#116): writing §6 is a clarification of `v1`, not a `v2`.** The semantics section was
added to a profile that had already been published without one, which raises the question fairly:
a client that negotiated `v1` against a document with no semantics got no semantics, so is pinning
them a new version?

No, and deliberately so. `v1` did not previously specify _different_ answers that are now being
changed — it specified none, and every rule §6 records is the one a careful reading of §1–§4
already forced:

- three-valued logic follows from `isnull` being the only NULL test (if NULL were an ordinary
  value, `eq(field, null)` would be its spelling, and §2.3 refuses it);
- `NotIn` ≡ `Not(In)` follows from `null` never being a literal, which is what removes SQL's
  divergence between the two;
- comparison on the encoded form follows from §2.3, which already constrains an attribute's
  encoded form to a JSON scalar and makes the literal codec the wire contract.

So no conforming `v1` implementation has to change behaviour, and no client has to re-negotiate.
Bumping to `v2` would cost every deployment a re-advertisement for no observable difference, and
would leave `v1` permanently undefined — the worse outcome for exactly the implementers a profile
exists to serve.

The forward rule is the one above, now explicit: **a change to any truth table, to the comparison
domain, or to the absent-attribute rule is a `v2`**, because each changes an answer a conforming
client can observe.

- Per the spec, unknown profiles in `Accept` are ignored, never rejected; the existing negotiation
  middleware already does this (`src/Middleware.ts:83`). Nothing about request handling keys off
  the profile parameter: an endpoint declared with `filter: true` speaks the grammar whether or not
  the client names it.
- The URI above is final: `https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1`.
  It must stay stable now that it is published.

## 6. Semantics

What a tree _means_: which resources a server returns for a given filter. This section is
normative, and it is this profile's own — a conforming implementation needs nothing outside this
document.

JSON:API leaves `filter` semantics implementation-defined precisely so that a profile can pin them
(§Query Parameters, and the `filter` family's own section). Pinning them is therefore _completing_
this profile, not adding an opinion the specification declined to have. Two independent servers
advertising this profile URI must answer `filter[status][eq]=draft` identically, and a client that
negotiates it must know what it is asking for; neither is possible without the rules below.

Every rule here has a conformance test in `src/Filter.semantics.test.ts`, run against the reference
interpreter of [§6.8](#68-the-reference-interpreter).

### 6.1 Scope

These rules govern the **closed operator core** of [§4](#4-the-operator-core-is-closed) —
`eq ne lt lte gt gte in nin isnull` and the `and` / `or` / `not` groups — over the fields of
[§1.2](#12-fields), which are a resource's declared attributes plus its declared to-one
relationship names. That is the whole language; there is nothing else to give meaning to.

In particular there is no relationship traversal to specify. That was settled in #82 and is
recorded in §4's exclusions; [#119](https://github.com/thomasfosterau/effect-jsonapi/issues/119)
was closed as not planned for proposing to reopen it on a downstream library's behalf. If
traversal is ever wanted it is a new operator, therefore a `v2` profile
([§5](#5-profile-uri)), and it must be argued on JSON:API's terms with the URL-surface
cost-control question answered.

### 6.2 The logic is three-valued

Evaluation yields **TRUE**, **FALSE** or **UNKNOWN**. A server returns exactly the resources for
which the filter evaluates to TRUE; UNKNOWN is not TRUE, so those resources are absent from the
response.

UNKNOWN arises in one way: a comparison whose field is NULL. `isnull` is the exception and is never
UNKNOWN — it is the operator whose entire job is to observe NULL.

| Node                            | Field is NULL                                     | Field is not NULL                        |
| ------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| `eq` `ne` `lt` `lte` `gt` `gte` | UNKNOWN                                           | TRUE / FALSE by [§6.6](#66-comparison)   |
| `in` `nin`                      | UNKNOWN                                           | TRUE / FALSE by [§6.5](#65-in-and-notin) |
| `isnull`                        | TRUE (`negated: false`) / FALSE (`negated: true`) | FALSE / TRUE                             |

Negation and the groups use the Kleene tables:

| `p`     | `not p`     |
| ------- | ----------- |
| TRUE    | FALSE       |
| FALSE   | TRUE        |
| UNKNOWN | **UNKNOWN** |

| `and`       | TRUE    | FALSE | UNKNOWN |
| ----------- | ------- | ----- | ------- |
| **TRUE**    | TRUE    | FALSE | UNKNOWN |
| **FALSE**   | FALSE   | FALSE | FALSE   |
| **UNKNOWN** | UNKNOWN | FALSE | UNKNOWN |

| `or`        | TRUE | FALSE   | UNKNOWN |
| ----------- | ---- | ------- | ------- |
| **TRUE**    | TRUE | TRUE    | TRUE    |
| **FALSE**   | TRUE | FALSE   | UNKNOWN |
| **UNKNOWN** | TRUE | UNKNOWN | UNKNOWN |

`And([])` is TRUE and `Or([])` is FALSE, the identities of their conjunctions — as
[§1.1](#11-nodes) already states.

**The consequence worth stating plainly**, because it is the question this section most exists to
answer: if a resource's `status` is NULL, then `?filter[status][ne]=done` does **not** return it,
and neither does the group form of `NOT (status = done)`. Both are UNKNOWN. A client that wants the
NULL rows as well asks for them: `NOT (status = done) OR status IS NULL`, which the group form
spells directly.

**Why three-valued.** Two-valued logic is the alternative, and it would make `ne` and `not` return
NULL rows. It was rejected on implementability: the great majority of JSON:API servers are backed by
a SQL engine whose `WHERE` clause is already three-valued, so a two-valued profile would oblige
every one of them to actively deviate — injecting `OR field IS NULL` at each negation, defeating
indexes, and silently diverging wherever an implementer forgot. A profile whose rules are the ones
implementations naturally follow is a profile that gets implemented correctly. The grammar also
points this way on its own: making `isnull` the _only_ NULL test, and refusing `null` as a literal,
is what a language does when NULL is not an ordinary value.

### 6.3 The subject, and absent attributes

A filter is evaluated against one resource's **decoded attribute values** — the same decoded types
the literals carry ([§2.3](#23-literals-and-lists)), not the wire strings.

**An attribute that is absent is NULL.** A resource object that carries no key for a declared
field, and one that carries the key with the value `null`, are indistinguishable to every operator
in this profile. The alternative — a fourth state, distinct from NULL — was rejected because it
would need a fourth truth value and a second spelling to test for it, and the grammar already has
exactly one way to say "has no value".

This is about a _resource_ lacking a value, not about the _field_ being unknown. Filtering on a
field the resource type does not declare filterable is a 400 at the codec
([§2](#2-surface-syntax)) and never reaches evaluation.

### 6.4 NULL is never a literal

There is no wire spelling that produces a `null` literal. `filter[status]=null` is the
four-character string `"null"` on a string attribute, and a literal-decoding 400 on a number
attribute — [§2.3](#23-literals-and-lists), unchanged.

Normatively, for an AST built in code rather than parsed from a URL: **`null` in any literal
position is invalid**, and the `Filter.Ast` schema rejects it, in both scalar (`Compare.value`) and
list (`In.values`, `NotIn.values`) positions. The error names `isnull` as the operator to use
instead. Every other decoded value is admissible, falsy ones included: `""`, `0` and `false` are
ordinary literals.

### 6.5 `in` and `nin`

`In` is TRUE when the field's value equals some member of the list under
[§6.6](#66-comparison), FALSE when it equals none, and UNKNOWN when the field is NULL.

**`NotIn` is exactly `Not(In)`** — including the UNKNOWN case, where both are UNKNOWN.

This is worth stating because SQL's `NOT IN` and `NOT (x IN ...)` famously differ: `x NOT IN (1,
NULL)` is UNKNOWN even for an `x` that is plainly not 1. That divergence requires a NULL _inside
the list_, and [§6.4](#64-null-is-never-a-literal) makes that unrepresentable — the lists are
non-empty and hold no NULL. So the two spellings cannot come apart in this profile, and `NotIn`
exists only because interpreters emit `NOT IN` directly and the shorthand surface names it
([§1.1](#11-nodes)).

An implementation compiling to SQL should be aware that it gets this for free only because the
profile guarantees no NULL literal reaches the list.

### 6.6 Comparison

The literals are _decoded_ values of arbitrary schemas — a `Schema.DateFromString` attribute
filters by a `Date`, a branded string by a branded string — so "what does `gt` mean here" has to be
answered rather than assumed. The profile answers it in two halves, because equality can be total
and ordering cannot.

**Equality** (`eq`, `ne`, `in`, `nin`) is equality of the **encoded wire form**. Two values are
equal iff the attribute's literal codec encodes them to the same string.

This is total: [§2.3](#23-literals-and-lists) already requires every filterable attribute's encoded
form to be a JSON scalar, or to supply an explicit `Codec<Type, string>`, so every declarable
attribute has an encoding and therefore an equality. It also costs nothing to define, because it is
the same encoding the canonical string of [§3](#3-canonical-encoding) is built from — two filters
that are byte-identical canonically compare literals identically, which is the property a cache tag
or a subscription identity needs. Two `Date` values for the same instant are equal; a brand is
erased by encoding and so never affects equality; a custom schema gets a well-defined equality
without the profile knowing anything about its decoded type.

**Ordering** (`lt`, `lte`, `gt`, `gte`) is the order of the **decoded** value, and is defined for
four kinds only:

| Decoded kind | Order                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| `string`     | Code-point order (Unicode scalar values, ascending). Not locale collation. |
| `number`     | Numeric order over finite IEEE-754 doubles.                                |
| `bigint`     | Numeric order.                                                             |
| `Date`       | Chronological, by instant.                                                 |

**Anything else has no ordering in this profile, and a conforming implementation must not declare
an ordering operator on it.** A boolean attribute, or one whose decoded value is a structure, is
comparable for equality and nothing more; the reference interpreter raises rather than inventing an
order, and `Resource.attribute(schema, { filter: [...] })` should name only
`eq ne in nin isnull` for such an attribute.

Three consequences worth being explicit about:

- **Ordering is on the decoded value, equality on the encoded one.** They agree, because an
  attribute's encoding is injective; the split exists because encodings are not order-preserving in
  general. A number encodes to `"10"`, which sorts before `"9"` as text — so numbers must be ordered
  numerically, not as their encodings.
- **String order is by code point, not by code unit and not by locale.** Locale collation is not
  portable — two conforming servers on different collations would disagree — so the profile fixes
  the one order every engine can implement identically. The practical cost is real and should be
  planned for: a Postgres server whose database collation is not `C` must apply `COLLATE "C"` (or
  equivalent) to conform on `lt` / `lte` / `gt` / `gte` over strings. Note also that code-point
  order is not UTF-16 code-unit order, which is what a naive JavaScript `<` gives: `"\uFFFD"` sorts
  _before_ an emoji by code point and _after_ it by code unit.
- **An attribute whose encoding is not order-consistent with its decoded value must not declare
  ordering operators.** `Schema.DateFromString` is the model case of one that is: ISO-8601 UTC text
  sorts chronologically, so a server comparing the stored timestamp and a server comparing the
  encoded string agree. A schema encoding a decimal as a string does not have that property, and
  ordering it would put two conforming implementations in disagreement.

### 6.7 What this profile does not govern

- **`sort` ordering.** This profile governs `filter`. Which order `?sort=` produces, and where
  NULLs land in it, is `Sort`'s and is deliberately not pinned here: folding it in would mean a
  change to sort behaviour forces a new _filter_ profile version, and the two are negotiated as one
  URI. The comparison rules of §6.6 are about `lt` / `gt` / `in`, nothing more.
- **Pagination, sparse fieldsets, includes.** Other query families, other rules.
- **Which resources a server _may_ show a client.** Authorization is not filtering. A filter
  narrows a collection the client is already entitled to; it is not a mechanism for deciding
  entitlement, and this profile takes no position on how a server decides what a request may see.

### 6.8 The reference interpreter

**Decision (#116): the package ships one**, as `Filter.evaluate` (the three-valued truth) and
`Filter.matches` (TRUE only), over a record of decoded attribute values.

The argument for shipping it is that a profile which cannot be executed is only prose. An
implementer adopting this document needs an oracle to check themselves against, and the rules above
need tests — a truth table asserted only in Markdown is a truth table that drifts. Shipping the
interpreter makes §6 executable for everyone, not just for this repository's test suite. It is also
`Schema`-only, so it reaches the schema-only tier of the package and costs a client nothing.

The argument against was that evaluation is behaviour this package has never shipped: it builds
schemas, codecs and endpoints, and a real server filters in its database, not in JavaScript. That
is true, and it shapes what the interpreter is rather than whether it exists. It is a plain
predicate over decoded records — the normative reference and a conformance oracle, plus the honest
use of filtering an in-memory collection (a fixture, a test double, an already-fetched page). It is
not a query engine and makes no claim to be one; a server backed by a database implements §6 in its
own dialect and uses this to check that it agrees.

## 7. Error pointers

Every rejection is one JSON:API error object with `status: "400"` and
`source: { parameter: "<flat key>" }`, where the flat key is the bracketed wire key as received
(`filter[age][gt]`, `filter[c][condition][operator]`). The codec raises each failure as a
`SchemaIssue.Pointer([flatKey], issue)` — several failing keys as a `Composite` of them — so the
issue path names the key, and the `SchemaErrors` middleware (`Middleware.schemaErrorDocument`)
renders one error object per issue leaf: `detail` is the issue's message and `source` is derived
from the part that failed and the leaf's path — `source.parameter` for a query (a nested path is
re-bracketed, `["page", "limit"]` → `page[limit]`, so the grammar's single-segment keys pass through
unchanged) or path parameter, `source.header` for a header, `source.pointer` (a JSON Pointer) for a
body. When no source can be derived the document is the single-error one of before. HttpApi decodes
each request part with the default parse options (`errors: "first"`), so outside the `filter`
family — whose codec composites every offending key itself — a part yields one error object. The
documents are tested end to end, not only the thrown issues.

Unknown field, undeclared operator and bad literal are three distinct failures with three distinct
`detail` strings and the same `source.parameter` shape (#84, #86 acceptance).

## 8. Interaction with the rest of `Query.schema`

- `filter: true` turns the grammar on, over the resource's declaration (#84). Passing a field map
  (`filter: { q: Schema.String }`) keeps today's open, per-key escape hatch unchanged
  (`README.md:705-707`); an endpoint uses one or the other. Heterogeneous endpoints (several
  resources) keep the escape hatch in phase 1.
- Default is off: an undeclared attribute is not filterable, matching `include` / `fields` / `sort`.
- `sort: true` keeps meaning "every attribute"; the declared sortable set — the attributes piped
  through `Sort.able()` (or `Resource.attribute(schema, { sort: true })`) — is an allow-list a
  consumer passes explicitly (`sort: Resource.sortable(Article)`), so no existing endpoint changes
  behaviour.
- The flat-key reshaper (`src/internal/codecs.ts:115-147`) handles one bracket level. `filter[*]`
  keys are routed to the grammar (`src/internal/filter.ts`) ahead of it, so `page[*]` and
  `fields[*]` are untouched. On the wire side of `Query.schema` they are an index-signature rest
  (`Query.FilterRest`) of the flat struct, since the group form admits any id.
- Literal codecs run synchronously in the codec; a codec that needs an asynchronous service fails
  decoding rather than being awaited.

## 9. Reviewed against usage

A survey of 23 real filter sites across four applications (16 `eq`, 2 `in`, values mostly ids, one
boolean; no NULL filters and no traversal) is fully expressible in bare shorthand, unchanged from
what those sites emit today (`filter[status]=open`, `filter[priority]=1,2`). The survey is
[thomasfosterau/legation#148](https://github.com/thomasfosterau/legation/issues/148)'s, cited here
as evidence about how `filter` is used in practice — the grammar and its meaning are §1–§6 of this
document and are not derived from it.

Two things the survey confirms: the shorthand carries the overwhelming majority of real filters, so
the group form's verbosity is a cost paid only by the queries that need it; and NULL filtering is
rare enough in practice that [§6.2](#62-the-logic-is-three-valued)'s choice is unlikely to surprise
anyone in the common case, which is a reason to document the surprising case loudly rather than a
reason to change it.
