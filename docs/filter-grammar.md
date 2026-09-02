# Filter grammar

Design note for the `filter` query family. Tracks [#83](https://github.com/thomasfosterau/effect-jsonapi/issues/83)
(epic [#82](https://github.com/thomasfosterau/effect-jsonapi/issues/82)). The interpreters that give the
grammar meaning live in Legation
([thomasfosterau/legation#148](https://github.com/thomasfosterau/legation/issues/148)); this note fixes
the part both sides must agree on byte for byte: the AST, the operator core, the URL surface, the
canonical encoding and the profile URI.

**Status:** draft for review. Implemented by
[#84](https://github.com/thomasfosterau/effect-jsonapi/issues/84) (per-attribute declaration),
[#86](https://github.com/thomasfosterau/effect-jsonapi/issues/86) (codec) and
[#85](https://github.com/thomasfosterau/effect-jsonapi/issues/85) (canonical `self` string).

## 0. Scope and decisions already taken

Settled in #82, not reopened here:

- Operator core `eq ne lt lte gt gte in nin isnull` plus `and or not` groups. No relationship
  traversal, no pattern matching, no text search.
- Shorthand desugars into the group form. `filter[f]=v` stays `eq`, `filter[f]=a,b` stays `in`.
- Literals are typed by the attribute schema. `NULL` is not a literal; use `isnull`.
- Semantics are Postgres-normative and three-valued, recorded in Legation's ADR-0028
  ([thomasfosterau/legation#151](https://github.com/thomasfosterau/legation/issues/151)). The AST
  carries no semantics.
- Ships as a documented profile URI, not an `ext` extension.

Two things below go further than the issue text and are called out where they occur:
[§1.2](#12-fields) proposes admitting to-one relationship names as fields, and
[§7](#7-error-pointers) records that the error middleware needs extending before `source.parameter`
can be emitted.

## 1. The AST

The AST is an **initial encoding**: plain data, an Effect `Schema` union, no methods. Every
consumer (the URL codec here; SQL, JS and IndexedDB interpreters in Legation) pattern-matches on it.

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
  and a codec that must be total cannot carry a node it cannot encode. Legation's `Predicate.In` with
  an empty list is a bridge concern (`toFilterAst` returns `None`, or rewrites to `Or([])`).
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

> **Proposed widening (needs a decision).** #83 says "attribute names of the primary resource
> only". The code argues for also admitting **to-one relationship names**, valued by the target's
> `id` string: the README's canonical example is `filter[author]=9`
> (`README.md:496-501`); `examples/northwind` models reverse relationships as `filter[category]`,
> `filter[customer]`, `filter[manager]` endpoints; the JSON:API recommendation itself is
> `GET /comments?filter[post]=1`; and the empirical table in legation#148 (16 `eq`, values are ids)
> is mostly foreign keys, which a JSON:API resource exposes as relationships, not attributes. This
> is not traversal: there is no path, the literal is the related id, and only `eq ne in nin isnull`
> apply. If rejected, consumers must expose each foreign key as a read-only attribute as well as a
> relationship, and `filter[author]=9` in the README example moves to the escape hatch. The rest of
> this note is unaffected either way; "attribute" below reads as "declared field".

### 1.3 What the AST does not carry

Nothing about evaluation. NULL handling, collation, type coercion, absent-attribute rules and the
per-operator truth tables are ADR-0028's. Two facts are fixed here only because the codec needs
them: literals are typed by the attribute schema, and `NULL` is not a literal.

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
decodes to a `Date` and re-encodes via the attribute's own encoder (`toISOString()`), which is also
the ISO-8601 UTC text ADR-0028 compares. An attribute whose encoded form is not one of these
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
(`filter[c][condition][operator]`, say); a structural failure (a dangling `memberOf`) points at the
key that names the missing target.

## 3. Canonical encoding

The canonical string is what `self` links carry ([#85](https://github.com/thomasfosterau/effect-jsonapi/issues/85))
and what Legation uses as the identity of a subscription, a coverage window and an HTTP cache tag.
So it must be a **function of the AST alone**: two URLs that decode to the same tree canonicalise to
the same bytes, whatever their key order, ids, escaping or `[eq]`/bare spelling.

### 3.1 Which form the encoder emits

Shorthand is emitted when, and only when, it decodes back to the same tree:

- The root is a single `Compare` / `In` / `NotIn` / `IsNull`, **or**
- the root is an `And` with two or more members, all of them conditions, whose `(field, operator)`
  pairs are pairwise distinct.

Everything else (any `Or` or `Not`, any nested group, an `And` with one member or with a repeated
`(field, operator)` pair, a bare `And([])`) is emitted in the group form. `And` with one member and
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
and joining with `&` are #85's job and identical for every family.

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
| case-insensitive match (`ilike`, `ieq`)  | Case folding is locale- and collation-dependent; ADR-0028 fixes code-point order only.               |
| full-text search                         | Tokenisation, stemming and ranking are engine-specific and non-deterministic across targets.         |
| array / JSON operators (`@>`, `?`, `->`) | No SQLite or IndexedDB equivalent; literals would stop being scalars typed by the attribute.         |
| regular expressions                      | Three incompatible regex dialects; unbounded evaluation cost.                                        |
| relationship traversal (`author.name`)   | An `EXISTS`; Legation D1 keeps it server-only with no URL form.                                      |
| `between`                                | Sugar for `gte AND lte`; a second spelling would break canonical identity.                           |

Adding an operator is a new grammar version and a new profile URI ([§5](#5-profile-uri)).

## 5. Profile URI

The grammar is a JSON:API **profile**, not an `ext`: it constrains how a server interprets
`filter[*]`, which the spec leaves to the implementation, and changes nothing about document
structure. Servers advertise it on the media type of responses to endpoints that implement it:

```
Content-Type: application/vnd.api+json; profile="https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1"
```

- The URI is exported as a constant (`Query.FILTER_PROFILE_URI`, #86) and is a version of this
  document. `v1` is this note; an incompatible change (a new operator, a changed canonical rule)
  is `v2`.
- Per the spec, unknown profiles in `Accept` are ignored, never rejected; the existing negotiation
  middleware already does this (`src/Middleware.ts:83`). Nothing about request handling keys off
  the profile parameter: an endpoint declared with `filter: true` speaks the grammar whether or not
  the client names it.
- The host is a placeholder pending a decision; the URI must be stable once published, so it is
  fixed in the #86 PR, not here.

## 6. Where semantics live

This repo owns the AST, the URL codec, the per-field declaration and the canonical string. It
takes no position on what a tree _means_ beyond the two facts in [§1.3](#13-what-the-ast-does-not-carry).
Everything else, including the Kleene tables for `and`/`or`/`not` over NULL, the `in` rule, the
absent-attribute rule, collation and numeric domains, is ADR-0028
([thomasfosterau/legation#151](https://github.com/thomasfosterau/legation/issues/151)), and the
interpreters are Legation's L4/L5. A consumer of this library alone gets a typed tree and is free to
evaluate it however it likes, but two consumers that want to agree with each other should adopt
ADR-0028.

## 7. Error pointers

Every rejection is one JSON:API error object with `status: "400"` and
`source: { parameter: "<flat key>" }`, where the flat key is the bracketed wire key as received
(`filter[age][gt]`, `filter[c][condition][operator]`). The existing `SchemaErrors` middleware turns
request-validation failures into 400 documents, but today with `detail` only
(`src/Middleware.ts:301-307`; `ApiError.BadRequest` carries no `source`). #86 therefore also:

- raises codec failures as `SchemaIssue.Pointer([flatKey], issue)` so the path names the key;
- extends `BadRequest` (or the middleware's mapping) to emit `source.parameter` from a `Query`
  / `Params` issue path and `source.pointer` from a `Body` path;
- tests the rendered document, not only the thrown issue.

Unknown field, undeclared operator and bad literal are three distinct failures with three distinct
`detail` strings and the same `source.parameter` shape (#84, #86 acceptance).

## 8. Interaction with the rest of `Query.schema`

- `filter: true` turns the grammar on, over the resource's declaration (#84). Passing a field map
  (`filter: { q: Schema.String }`) keeps today's open, per-key escape hatch unchanged
  (`README.md:705-707`); an endpoint uses one or the other. Heterogeneous endpoints (several
  resources) keep the escape hatch in phase 1.
- Default is off: an undeclared attribute is not filterable, matching `include` / `fields` / `sort`.
- `sort: true` keeps meaning "every attribute"; the declared sortable set is an allow-list a
  consumer passes explicitly (`sort: Resource.sortable(Article)`), so no existing endpoint changes
  behaviour.
- The flat-key reshaper (`src/internal/codecs.ts:115-147`) handles one bracket level. `filter[*]`
  keys are routed to a dedicated reshaper ahead of it, so `page[*]` and `fields[*]` are untouched.

## 9. Reviewed against usage

legation#148's table (23 filter sites across four example apps: 16 `eq`, 2 `in`, ids and one
boolean, no NULL filters, no traversal) is fully expressible in bare shorthand, unchanged from what
those sites emit today (`filter[status]=open`, `filter[priority]=1,2`). Legation's current encoder
drops `ne` / `gt` / `or` / `not` / `eq null`
(`packages/jsonapi/src/JsonApiQuery.ts:46-58`); under this grammar all of them have an exact form
(`eq null` becomes `isnull=true`), which is what lets L7 delete `safeFilters`.
