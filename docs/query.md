# Query parameters

| Family | Wire form | Decoded form |
| --- | --- | --- |
| `include` | `?include=author,comments.author` | `ReadonlyArray<"author" \| "comments" \| "comments.author">` — literal paths from the relationship graph ([constrainable](#constraining-the-advertised-include-paths)) |
| `fields[TYPE]` | `?fields[articles]=title,author` | `{ articles?: ReadonlyArray<"title" \| "body" \| "author" \| …> }` — closed per-type sets of attribute and relationship names |
| `sort` | `?sort=-createdAt,title` | `[{ field: "createdAt", direction: "desc" }, …]` |
| `page[*]` | `?page[offset]=0&page[limit]=10` | `{ offset?: number, limit?: number }` (`Page.Offset`, `Page.Number`, `Page.Cursor`, or custom) |
| `filter[*]` | `?filter[status]=open&filter[age][gt]=18` | `Filter.Ast` — one root node over the declared fields ([the filter grammar](filter-grammar.md), `filter: true`); fails closed on undeclared fields, operators and literals. Or a user-defined schema per key (`filter: { q: … }`) |

Unknown include paths, unknown sparse-fieldset names, unknown sort fields, and — under the grammar — unknown filter fields, undeclared operators and bad literals fail decoding, which the schema-error middleware turns into a spec-compliant **400 JSON:API error document** whose error objects carry `source.parameter` naming the offending key (`filter[age][gt]`, `page[limit]`) — and, where the schema publishes what it would have accepted, the legal vocabulary as `meta`: a rejected `include` path carries `meta.includablePaths` (the endpoint's whole supported set, as `ApiError.UnsupportedIncludePath` does) and an unknown `sort` field `meta.sortableFields`, so a caller that guessed wrong needs no second request. HttpApi decodes a request with `errors: "first"`, so a query yields one error object — except the `filter` family, whose codec reports every offending key together.

Every comma-separated family also accepts the repeated-key spelling `UrlParams.toRecord` produces for a repeated key — `?sort=-createdAt&sort=title` decodes the same as `?sort=-createdAt,title`, and likewise for `include` and `fields[TYPE]` — in any mix of the two, and `filter[*]` accepts a repeated key at its list-valued positions ([the filter grammar](filter-grammar.md) §2). Encoding always emits the single comma form.

A parameter the endpoint's query does not declare never reaches the handler: decoding drops it, on an endpoint whose query declares no family at all (its decoded `query` is then `{}`) as on any other, and no spelling of one — a bare name next to its bracketed members, empty brackets, deeper nesting — can make the query fail to decode.

The specification's own families are the exception: on an endpoint that does not support one — whose `query` doesn't declare it, as `Endpoint.get(R)` without `include`, any endpoint without `sort`, or any `Endpoint.get` for `page[…]` and `filter[…]` — the parameter, whatever its value (an empty `?include=` too), is a 400 naming it in `source.parameter` rather than being dropped. JSON:API 1.1 requires it: §Inclusion of Related Resources for `include`; §Sorting for `sort` on an endpoint that responds with a resource collection; and for every other case, `sort` on a single-resource endpoint such as `GET /articles/1?sort=title` included, the general §Implementation-Specific Query Parameters rule, since the endpoint does not know how to process the parameter. The `SchemaErrors` middleware answers it before the endpoint decodes anything, so it also wins over a 406 or 415 the same request would get. An endpoint that declares the family with an empty vocabulary (`include: { paths: [] }`, `include: true` over a resource with no relationships, `sort: true` over one with no attributes, `filter: true` over one with no filterable field, `page: {}`, `filter: {}`) supports no value of it, so it gets the same 400, an empty value included.

`fields` is per resource type, and its names are the type's fields: its attributes and its relationships, which share one namespace ([§Fields](https://jsonapi.org/format/1.1/#document-resource-object-fields)). A `fields[TYPE]` is supported only for a type the endpoint declares a sparse fieldset for and whose resource has at least one field. `fields: true` declares every type the response can carry and no other: the resource; its non-`paginated` direct relationship targets, which a server MAY include by default, unless `include` is a declared `Include.Surface`; and, when `include` is on, every type a legal include path reaches (`include: true`'s `comments.author` declares `fields[people]`). So with `include` off it is the resource and its non-`paginated` direct targets; under `include: true`, `{ depth }` or `{ paths }`, those plus every type on the way down each legal path; under a surface, exactly the resource and the types its paths reach (its `included` union). `Query.schema` also takes `fields` as an allow-list of those types (`fields: ["comments", "people"]`, as `sort` takes one of attributes), declaring `fields[TYPE]` for the listed ones alone, which is how `Endpoint.getRelationship` leaves out its parent's type; a listed type outside the set throws at construction. Where one of those is a `Resource.family`, its member types are declared in its place (a member that is itself a family by its own members, in turn), since those are the types its resource objects carry: a relationship targeting a family over `editors` and `reviewers` declares `fields[editors]` and `fields[reviewers]`, and `fields[<family name>]` is not declared, so it is a 400 like any other undeclared type. A type reachable only through a `paginated` relationship is never in `included`, so it is never declared. Any other `fields[TYPE]` (a type outside that set, or one with no field), a bare `fields` and a `fields[TYPE][…]` are each a 400 naming that parameter, while the endpoint's other `fields[TYPE]` keep decoding. Ignoring such a fieldset would answer with the fields the client excluded, which §Sparse Fieldsets forbids: "If a client requests a restricted set of [fields] for a given resource type, an endpoint **MUST NOT** include additional [fields] in resource objects of that type in its response."

`page` and `filter` are per member too. On an endpoint that declares page keys (`Page.Offset`'s `page[offset]` / `page[limit]`, `Page.Number`, `Page.Cursor`, custom keys, a `Query.bracketPageKeys` struct) or an explicit filter map (`filter: { status: … }`), a member it does not declare — `?filter[stauts]=open` beside `filter[status]`, `?page[sise]=10` or `?page[size]=10` beside `Page.Offset`, a deeper `filter[status][eq]`, a bare `filter` or `page` — is a 400 under the spec's general rule (§Query Parameters: a server that does not know how to process a parameter from the specification **MUST** answer `400 Bad Request`), with `source.parameter` naming it as the request spelt it and a `detail` listing the members the endpoint does declare. Dropping it would hand the client an unfiltered or unpaginated collection it took for the one it asked for. A member counts by its wire name, so `Schema.encodeKeys({ state: "filter[status]" })` declares `filter[status]`. `filter: true` is unchanged: the open grammar declares the bare `filter` and every `filter[…]`, and rejects a malformed member itself; a hand-built open record of a family (`Schema.Record(Schema.TemplateLiteral(["filter[", Schema.String, "]"]), …)`) likewise admits every member it opens. `Middleware.checkQueryParameters` applies the same rule to its `declared` list.

`include` and `sort` have no members at all: JSON:API defines only the bare parameters. So a bracketed one — `?include[]=author`, `?include[x]=author`, `?sort[title]=1`, `?sort[x][y]=1` — is a 400 naming it under the spec's general rule, on an endpoint that declares the bare `include` / `sort` as on one that doesn't; the query schema would otherwise drop it and the handler would see `{}`. Declared means supported: a hand-built `query` schema with a `"sort[x]"` property of its own supports that very name, and no other `sort[…]`. `Middleware.checkQueryParameters` treats a declared `include` or `sort` the same way.

## Declaring filterable and sortable attributes

Filterability is a per-resource property, declared per attribute: which attributes, which operators, and (from the attribute's own schema) what literal type. The declaration lives on the attribute schema itself: pipe it through `Filter.able` / `Sort.able` — Effect-native combinators in the manner of `Schema.brand` — and it rides with the schema as an annotation (`Filter.AnnotationId` / `Sort.AnnotationId`), the single source of truth `Resource.filterable` / `Resource.sortable` read back. An attribute declared with neither — or a plain `Schema` attribute — is not filterable and not sortable, so the declaration fails closed the way `include` / `fields` / `sort` already do.

```ts
import { Filter, Relationship, Resource, Sort } from "@thomasfosterau/effect-jsonapi";
import { Schema } from "effect";

const Product = Resource.make("products", {
  attributes: {
    name: Schema.NonEmptyString, // neither filterable nor sortable
    // a subset of the operator core, spelt as constants, and sortable
    priceCents: Schema.Int.pipe(
      Filter.able([Filter.Op.eq, Filter.Op.gt, Filter.Op.lt]),
      Sort.able(),
    ),
    // the whole core: eq ne lt lte gt gte in nin isnull (`Filter.operators`)
    discontinued: Schema.Boolean.pipe(Filter.able()),
    // server-set, so read-only — and the usual sort key
    createdAt: Resource.readOnlyAttribute(
      Schema.DateFromString.pipe(Filter.able(["gte", "lt"]), Sort.able()),
    ),
    // nullable: declare the member and wrap it — `isnull` names NULL, the literal is the number
    rating: Schema.NullOr(Schema.Finite.pipe(Filter.able(["gte", "isnull"]))),
  },
  relationships: {
    // a to-one relationship is a filter field too, valued by the related id
    supplier: Relationship.one(() => Supplier, { filter: ["eq", "in"] }),
  },
});

Resource.filterable(Product);
// → { priceCents: { operators: ["eq", "gt", "lt"], literal }, discontinued: { … }, createdAt: { … }, rating: { … }, supplier: { … } }
Resource.sortable(Product); // → ["priceCents", "createdAt"]
```

`Resource.attribute`'s `filter` / `filterLiteral` / `sort` options are sugar for exactly those calls on the inner schema — handy when the attribute takes a projection descriptor anyway — and stamp nothing else, so the two spellings are indistinguishable downstream, at runtime and in the types:

```ts
priceCents: Resource.attribute(Schema.Int, {
  create: "optional",
  filter: ["eq", "gt", "lt"],
  sort: true,
});
// ≡ Resource.attribute(Schema.Int.pipe(Filter.able(["eq", "gt", "lt"]), Sort.able()), { create: "optional" })
```

The operator vocabulary is a schema, `Filter.Operator` — a `Schema.Literals` over the closed core, from which `Filter.operators` and `Filter.isOperator` derive — and `Filter.Op` spells it as typed constants (`Filter.Op.gt` is the literal `"gt"`), so a typo is a compile error while plain strings stay accepted. Apply `Filter.able` / `Sort.able` as the last step of a pipe: the runtime declaration survives a later `.check(...)`, `.annotate(...)` or `Schema.brand`, but any rebuild drops the type-level marker (`Resource.FilterableKeys` / `SortableKeys` stop naming the attribute); wrapping the declared schema in `Schema.NullOr` or `Schema.optionalKey` afterwards keeps both.

`Resource.filterable(R)` is a read-only record keyed by the declared fields (undeclared ones are absent, so `Object.keys` is the filterable set); each entry carries the declared `operators` and a `literal` codec, `Schema.Codec<Type, string>`. For an attribute the codec is derived from the schema's encoded form — `string`, `number`, `boolean`, or `Schema.NullOr` of one. A wire string is parsed strictly as that scalar (`number` accepts only a finite decimal, `boolean` only `true` / `false`) and then decoded through the attribute schema itself, so refinements, brands, literal unions and `DateFromString` all apply: `filter[priceCents][gt]=abc` fails decoding rather than silently matching nothing. An attribute whose encoded form is not a scalar cannot be declared filterable (`Resource.make` throws, naming it) unless the declaration supplies an explicit codec: `Filter.able(["eq"], { literal: PointFromString })` (or the `filterLiteral` option).

To-one relationships (`Relationship.one` / `Relationship.optional`) take a `filter` option and become filter fields valued by the related resource's id — `filter[supplier]=9` — with the target's `Id` schema as the literal codec, so the decoded literal is the branded id. Only `eq ne in nin isnull` apply to a relationship (`Relationship.FilterOperator`, a narrowing of `Filter.Operator`); `filter: true` means those five, and declaring an ordering operator is a definition-time error. To-many relationships are not fields.

The resource id becomes a filter field when the schema passed as `Resource.make`'s `id` option is `Filter.able`, piped last. JSON:API reserves `id` as a field name, so an attribute named `id` is still refused; the id schema is where the declaration goes:

```ts
const Note = Resource.make("notes", {
  id: Schema.String.pipe(Filter.able(["eq", "in"])),
  attributes: { title: Schema.String },
});
Object.keys(Resource.filterable(Note)); // ["id"]
// ?filter[id]=n-1, ?filter[id][in]=n-1,n-2 and the group form all decode
```

`Resource.filterable` reports it under the key `id`, ahead of the attributes, with the id schema itself as its literal codec (or the declaration's explicit `literal`), so refinements and brands on the id apply to the literal. The default derived id is not filterable; `Resource.extend(base, type, { inheritId: true })` inherits the base id's declaration.

`Resource.sortable(R)` returns the declared attribute keys (attributes only), typed as their literal union, so it is the natural `sort` allow-list for an endpoint; `sort: true` keeps meaning "every attribute":

```ts
Endpoint.list(Product, { sort: Resource.sortable(Product), page: Query.Page.Offset });
// ?sort=-createdAt,priceCents decodes; ?sort=name is a 400
```

What a sorted collection must look like is [§10 of the profile](filter-grammar.md#10-sort-order), and it is the handler's job to produce it: ascending by each field's JSON value under the filter grammar's own comparison domain (numeric; code-point order for strings — no locale collation; ISO-8601 text for dates), NULLs (an absent attribute or `null`) **last** ascending and first descending, several fields lexicographically in the order given, and — a SHOULD — remaining ties broken by `id`, so the order is the same on every request and offset pagination over it neither repeats nor skips a resource.

`filter: true` on a list endpoint turns on the `filter` query codec over this declaration — the grammar in [`docs/filter-grammar.md`](filter-grammar.md). `filter[f]=v` is `eq`, `filter[f]=a,b` is `in`, `filter[f][gt]=v` any operator, and a Drupal-style group form (`filter[g][group][conjunction]=OR`, `filter[c][condition][path]=…`) spells `OR`, `NOT`, nesting and repeated `(field, operator)` pairs. Handlers receive one decoded, normalised `Filter.Ast` root node, with `field` narrowed to the declared names and every literal decoded through its attribute schema:

```ts
Endpoint.list(Product, { filter: true, sort: Resource.sortable(Product), page: Query.Page.Offset });

// GET /products?filter[priceCents][lt]=1000&filter[supplier]=9&filter[discontinued]=false
// → query.filter:
// { _tag: "And", members: [
//     { _tag: "Compare", op: "eq", field: "discontinued", value: false },
//     { _tag: "Compare", op: "lt", field: "priceCents", value: 1000 },
//     { _tag: "Compare", op: "eq", field: "supplier", value: "9" } ] }   // a branded Supplier id
```

`filter[name]=x` (undeclared), `filter[priceCents][gte]=1` (undeclared operator) and `filter[priceCents][lt]=cheap` (bad literal) are each a 400 whose `source.parameter` names the key. `Query.Filter(resource)` is the codec on its own (`Schema.Codec<Filter.Ast, Record<string, string>>`); encoding always emits the canonical form (§3 of the grammar: sorted, deduplicated, ids reassigned), and `Filter.normalise` puts a hand-built tree in the same normal form. The per-key map (`filter: { q: Schema.String }`) remains the escape hatch for flags JSON:API has no family for; an endpoint uses one or the other.

The grammar is a JSON:API **profile**, `Filter.PROFILE_URI` (`https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1`). Advertise it on the media type of responses from endpoints that speak it — `Content-Type: application/vnd.api+json; profile="…"` — clients that do not name it are served the same way, since unknown profiles are ignored, never rejected.

The profile defines what a tree **means**, not only how it is spelled: [§6 of the grammar](filter-grammar.md#6-semantics) is the normative semantics — three-valued (Kleene) logic, a truth table per operator including every NULL case, the comparison domain of each attribute type, and the line between a 400 and an empty result. Handlers are what evaluate a tree, so that section is the contract they answer to; this package builds, validates and canonicalises trees and evaluates none.

## The canonical query string

JSON:API 1.1 requires a collection document's `self` link to carry the query parameters the client provided. `Query.canonical(schema)` turns a decoded query into its **one** wire spelling: encoded through the schema, ordered by one rule, RFC 3986 percent-encoded. Two equal decoded queries produce byte-identical strings whatever spelling they came from — key order, `?include=a&include=b` against `?include=a,b`, `filter[f][eq]=v` against `filter[f]=v` — and the string decodes back to the same query through the same schema, which makes it a stable identity for a query (a subscription, a cache tag) as well as a `self` link.

```ts
const listQuery = Query.schema(Article, {
  include: true,
  fields: true,
  sort: true,
  page: Query.Page.Offset,
  filter: true,
});
const canonical = Query.canonical(listQuery);

canonical(query);
// → "include=author&fields[articles]=title&filter[status]=open&sort=-createdAt&page[offset]=0&page[limit]=10"
```

The order is `include`; `fields[*]` sorted by type; `filter[*]` in [the grammar's canonical order](filter-grammar.md#33-key-order-and-ids) (shorthand sorted by key, the group form in the encoder's pre-order); `sort`; `page[*]` in the page strategy's declared order (`offset, limit` — what the link builders emit); then any other key, sorted. Keys and values go through `encodeURIComponent` (spaces `%20`, commas `%2C` — a list's separator and the grammar's `\,` alike), with `[` / `]` left readable in keys; `URLSearchParams` / `UrlParams` decode the result back identically. `Query.canonicalPairs(schema)` is the ordered pair list before serialisation and `Query.serialise(pairs)` the encoding on its own.

The pagination link builders serialise the same way and take the other pairs as an option, so every link carries the full query with its page cursor slotted in:

```ts
handlers.handle("list", ({ query }) =>
  listArticles(query).pipe(
    Effect.map(({ items, total }) =>
      Handlers.collection(items, {
        meta: { total },
        links: Handlers.offsetPaginationLinks("/articles", query.page ?? {}, total, {
          query: Query.canonicalPairs(listQuery)(query),
        }),
        // self: "/articles?filter[status]=open&sort=-createdAt&page[offset]=0&page[limit]=10"
        // next: "/articles?filter[status]=open&sort=-createdAt&page[offset]=10&page[limit]=10"
      }),
    ),
  ),
);

// unpaginated: the canonical query on the collection's own `self`
Handlers.collection(items, { self: "/articles", query: Query.canonicalPairs(listQuery)(query) });
```

## Constraining the advertised include paths

`include: true` legalises the resource's **whole relationship graph, two hops deep** — every path `Query.Include` can derive. That is the right default when the endpoint can resolve all of them, and the wrong one when it can't: a to-one relationship on a related resource makes depth 2 advertise paths (`release.tracks`, say) whose resolver was never written. Advertising such a path answers `200` with an empty `included` — strictly worse than the `400` an unknown path already produces.

Pass an object instead of `true` to constrain the derivation — an explicit `paths` allow-list, a `depth` bound (`1` / `2` / `3`), or both, in which case `paths` wins. The literal path type narrows with it, so a client that asks for an unlisted path fails to compile as well as to decode:

```ts
// only the paths this endpoint actually populates
Endpoint.get(Work, { include: { paths: ["composer", "recordings"] } });

// …or just the direct relationships, whatever they are
Endpoint.list(Track, { include: { depth: 1 } });

// Query.Include takes the same options standalone
const include = Query.Include(Article, { paths: ["author"] });
// typeof include.Type === ReadonlyArray<"author">
```

Whatever bound the option sets, the default success document admits in `included` every resource the legal paths reach — the leaf of each path and every resource on the way down — beside the non-`paginated` direct targets, so every advertised path can be answered: under `include: true`, `comments.author` admits the `people` behind each comment.

The option is available wherever `include` is — `Endpoint.get` / `list` / `related` / `collection`, and `Group.resource` both top-level and per endpoint:

```ts
const works = Group.resource(Work, {
  include: { depth: 1 },
  endpoints: { get: { include: { paths: ["composer", "recordings"] } } },
});
```

A top-level constraint applies to `get` and `list`. The `related` endpoints' paths are their _target's_ graph, not this resource's, so they inherit only that `include` is on — constrain them with `Endpoint.related` directly if they need it too. The generated `getRelationship` endpoints take `relationshipInclude` instead (see [Compound relationship documents](endpoints.md#compound-relationship-documents)).

## Declaring the include surface once

An allow-list constrains _which_ paths are advertised, and the default document admits what they reach — but beside every direct target, so the `included` union is still wider than the paths, and the walk a handler runs to resolve them is declared somewhere else again. Those are separate declarations over separate inputs, and they drift.

`Include.make` is one nested declaration all three artefacts project from — the accepted-path whitelist, the `included` union, and the advertised parameter:

```ts
const surface = Include.make(Article, {
  author: Person,
  comments: Include.nested(Comment, { author: Person }),
});

surface.paths; // ["author", "comments", "comments.author"] — typed literals
surface.included; // Schema.Union([Person, Comment])
surface.has("comments.editor"); // false

// one option, all three:
Endpoint.get(Article, { include: surface });
Endpoint.list(Article, { include: surface });
Group.resource(Article, { include: surface });
```

Three properties are load-bearing:

- **The whitelist spells depth.** `comments` and `comments.author` are separate entries, so `comments.editor` is rejected even though `comments` is includable — the whole dotted path is matched, never just its head segment.
- **Nesting only ever _adds_ paths.** Wrapping a key in `Include.nested` keeps `?include=<key>` meaning exactly what it did.
- **The union carries every depth.** A walk that hoists a Comment _and_ the Person behind it needs both arms, or the deeper one is stripped on encode.

Every key is checked against the resource's relationship graph — an unknown key, a `paginated` relationship (never inlined) or a key declared against the wrong target is a compile error, and each is re-checked when the surface is built. `Include.paths(spec)` and `Include.included(spec)` are the same two projections standalone.

`Include.included` also answers for an endpoint rather than a declaration: given a resource, or the members of a `collection` / `polymorphic` endpoint, and the endpoint's `include` option, it returns the `included` union that endpoint's default document binds, for a `success` override to reuse (see [Overriding the success document](endpoints.md#overriding-the-success-document)):

```ts
Include.included(Article, { include: true }); // Endpoint.get / list over Article
Include.included(Article, { include: surface }); // surface.included
Include.included([Article, Person], { include: true }); // Endpoint.collection([Article, Person], …)
Include.included(AnyNode.members, { include: { depth: 1 } }); // Endpoint.polymorphic(AnyNode, …)
```

The members form also takes a declared surface and returns its `included`, which is what `collection` and `polymorphic` bind under that surface, as `get` / `list` / `related` do: the union narrows to what the surface names, dropping any direct target it leaves out.

Because the derivation recurses over the **declaration** rather than the relationship graph, a declared surface is not bound by the depth-2 ceiling `include: true` inherits: depth becomes a property of what you wrote. It is capped explicitly at `Include.MAX_DEPTH` (6) hops — the type-level derivation truncates past it and `Include.make` throws, so a too-deep declaration fails loudly at startup instead of silently advertising less than it declares.

A resource that declares no surface advertises no parameter, and `include: true` / `Query.IncludeOptions` behave exactly as before.

`Page.Offset` / `Page.Number` / `Page.Cursor` are the ready-made constants. For a **bounded, defaulted, dual-use** variant, call `Query.Page.offset(options)` (and, for page-number pagination, `Query.Page.number(options)`): it returns the same `{ offset, limit }` field-map but lets you cap `limit` with `maxLimit` (a DoS guard every JSON:API server wants), fill in `defaultLimit` / `defaultOffset` on decode, and — with `fromString: false` — build the fields from plain `Schema.Finite` instead of `FiniteFromString`, so the one schema works both as a numeric call-site input and behind a transport that coerces query strings to numbers (e.g. raw `HttpApiEndpoint` wrapped in `Schema.toCodecStringTree`).

```ts
// caps page size at 100, defaults to 25, still decodes from query strings
Endpoint.list(Article, { page: Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }) });
```

## Bracketing page keys on a query struct you own

`Query.schema`'s `page` option composes the whole query and **nests** the decoded cursor under a `page` key. Some applications instead merge pagination **flat** into their own list-input struct — `{ limit, offset, …filters }` — because the rest of the application consumes that flat type directly and shouldn't learn a transport-shaped nesting.

`Query.bracketPageKeys` is the standalone rename for exactly that case: given any struct carrying `offset` and `limit`, it re-keys **only those two encoded keys** to `page[offset]` / `page[limit]`, leaving the decoded type and every other field's wire key alone. The bracket family it produces is the same one `Handlers.offsetPaginationLinks` emits, so following a `next` link decodes straight back into the flat `{ offset, limit }` the list operation reads. A rejected value is reported under the name the request sent: `?page[limit]=abc` is a 400 with `source.parameter: "page[limit]"`, not the decoded `limit`, and the same holds for any property `Schema.encodeKeys` renames. Bodies, headers and path parameters follow the same rule: a renamed body member is named by its wire name in `source.pointer`, at any depth (`/data/itemCount` for a `count` sent as `itemCount`), a renamed header in `source.header` (`x-trace`) and a renamed path parameter in `source.parameter` (`itemId`).

```ts
const ListArticles = Schema.Struct({
  ...Query.Page.offset({ maxLimit: 100, fromString: false }),
  authorId: Schema.optionalKey(Schema.String),
});

const query = Query.bracketPageKeys(ListArticles);
// wire:    { "page[offset]": …, "page[limit]": …, authorId: … }
// decoded: { offset, limit, authorId }   ← unchanged, still flat
```

`Query.bracketKeys(prefix, keys)` is the general form `bracketPageKeys` is built on — any bracket prefix (`page`, `filter`, `fields`, or one of your own), any subset of the struct's own keys, and it **composes**: pipe it more than once to bracket several families onto the same flat struct, and the decoded/encoded types reflect every rename applied so far, not just the last one.

```ts
const ListArticles2 = Schema.Struct({
  ...Query.Page.offset({ maxLimit: 100, fromString: false }),
  authorId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
});

const query2 = ListArticles2.pipe(
  Query.bracketKeys("page", ["offset", "limit"]),
  Query.bracketKeys("filter", ["status"]),
);
// wire:    { "page[offset]": …, "page[limit]": …, "filter[status]": …, authorId: … }
// decoded: { offset, limit, status, authorId }   ← unchanged, still flat
```
