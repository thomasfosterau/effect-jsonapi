# `@thomasfosterau/effect-jsonapi`, a JSON:API package for Effect

Type-safe, spec-compliant [JSON:API v1.1](https://jsonapi.org/format/1.1/) implementation built on top of [Effect](https://effect.website)’s `HttpApi`, `Schema`, etc.

[![npm version](https://img.shields.io/npm/v/@thomasfosterau/effect-jsonapi.svg)](https://www.npmjs.com/package/@thomasfosterau/effect-jsonapi)

**Disclaimer:** This repository and package have been created using Claude Code. The package’s API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
pnpm add @thomasfosterau/effect-jsonapi effect
```

`effect` is a peer dependency (`>=4.0.0-rc.118`). Node.js 22 or newer is required.

## Overview

`@thomasfosterau/effect-jsonapi` makes it **trivial to comply with the JSON:API spec, invariantly** — compliance is a property of the construction, not of developer discipline:

- Define each **resource once**; identifiers, create/update payloads, documents, query parameters and endpoints are all derived from that single definition.
- Declare each **error once**; you get a tagged Effect error whose wire encoding _is_ a spec-compliant JSON:API error document with the right HTTP status.
- **Endpoints** bake in the conventions: the `application/vnd.api+json` media type, conventional paths, spec status codes (200/201/204), typed `include` / `fields[TYPE]` / `sort` / `page[*]` / `filter[*]` query parameters, and content-negotiation rules (406/415).
- Everything is a plain Effect `Schema` / `HttpApiEndpoint` / `HttpApiGroup`, so it composes with `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi` untouched.

## Quick start

A complete read API — resource, error, endpoints, handlers, server — in one file. Each piece is expanded in the sections below.

```ts
import { Effect, Layer, Schema } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import {
  ApiError,
  Endpoint,
  Group,
  Handlers,
  Middleware,
  Query,
  Resource,
} from "@thomasfosterau/effect-jsonapi";
// 1. Define a resource once — identifiers, payloads, documents and query
//    parameters are all derived from this single definition.
const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
});

// 2. Declare an error once — its wire encoding *is* a JSON:API error document.
class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  fields: { id: Schema.String },
  detail: (e) => `Article ${e.id} not found`,
}) {}

// 3. Build endpoints with the JSON:API conventions baked in.
const articles = Group.make(
  Article,
  Endpoint.get(Article, { include: true, errors: [ArticleNotFound] }),
  Endpoint.list(Article, { page: Query.Page.Offset }),
);

const Api = HttpApi.make("blog").add(articles);

// 4. Implement handlers — inputs are typed and validated, documents are checked
//    for the compound-document rules. (`loadArticle` / `listArticles` are your
//    own data access returning `Effect`s.)
const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      loadArticle(params.id).pipe(Effect.map((article) => Handlers.data(article))),
    )
    .handle("list", ({ query }) =>
      listArticles(query).pipe(Effect.map((items) => Handlers.collection(items))),
    ),
);

// 5. Wire it up — the api won't build unless the JSON:API middleware is
//    provided, so spec compliance can't be forgotten.
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(ArticlesLive),
  Layer.provide(Middleware.layer),
);
```

### The schema-only entry point

The package root exports everything and is the import you want by default. It reaches `effect/http-api`, because the error classes, endpoints, groups, media type combinators and middleware are built on Effect's `HttpApi`.

Consumers that only want JSON:API's **wire types without the server** — a client decoding documents, a loader mapping them into something else, a CLI or code generator producing them — can import the same modules from a schema-only subpath whose only dependency is `effect` itself:

```ts
import { Document, Resource } from "@thomasfosterau/effect-jsonapi/schema";
```

`/schema` re-exports `Document`, `Filter`, `FlatQuery`, `Include`, `Relationship`, `Resource`, `Sort` and `MEDIA_TYPE` — the modules whose import graph is `effect` alone. Every symbol is the same object under both imports. Which modules are in the tier, and why `Query` (whose `Query.validateIncludePaths` fails with `HttpApi`-bound error classes) and `Client` are not: see the `/schema` module doc.

## API

Every module is a namespace export of the package root (`import { Resource } from "@thomasfosterau/effect-jsonapi"`); the sections below walk through them in the order you would build a server.

| Namespace | Purpose |
| --- | --- |
| `Resource` | Resource definitions (`Resource.make`) — the single source of truth everything else derives from. |
| `Relationship` | Relationship constructors (`Relationship.one`, `Relationship.many`, …). |
| `Document` | Document-level schemas: links, meta, error objects, document shapes. |
| `ApiError` | One-shot error declarations (`ApiError.make`) and the standard errors every endpoint supports. |
| `Endpoint` | Endpoint constructors (`Endpoint.get`, `Endpoint.list`, …) with the JSON:API conventions baked in. |
| `Group` | Resource groups (`Group.make`, `Group.flat`). |
| `Query` | Typed query parameters (`Query.schema`, `Query.Page`, `Query.canonical`, …). |
| `Filter` | The `filter` query family: operators, per-attribute declaration, the filter AST. |
| `Sort` | The `sort` query family's per-attribute declaration (`Sort.able`). |
| `Include` | Declared `?include=` surfaces (`Include.make`, `Include.nested`). |
| `FlatQuery` | The flat list-input grammar (`FlatQuery.pagination`, `FlatQuery.listInput`, …). |
| `Handlers` | Server-side document builders (`Handlers.data`, `Handlers.collection`, …). |
| `Assemble` | The server-side document assembler over `Handlers`, with capability hooks. |
| `ResourceHandlers` | The server handler factory, counterpart of `Group.flat`. |
| `ServerErrors` | The server's error seam: the domain error catalogue and `ServerErrors.respond`. |
| `Registry` | The handler registry and router (`Registry.webHandler`). |
| `Negotiation` | The representation verdict for a host serving JSON:API on its page URLs. |
| `Middleware` | Protocol middleware (`Middleware.layer`): content negotiation, schema errors and the create's `Location` header. |
| `MediaType` | Media type annotation combinators for hand-rolled endpoints. |
| `Atomic` | The [atomic operations extension](https://jsonapi.org/ext/atomic/). |
| `Lid` | Local id (`lid`) resolution (`Lid.make`). |
| `Idempotency` | Idempotent writes — the `Idempotency-Key` profile. |
| `Client` | Client-side helpers: negotiation, error decoding, include narrowing and hydration, page cursors. |
| `Conformance` | The conformance kit: an executable specification a server is driven through. |
| `MEDIA_TYPE` | The JSON:API media type, `"application/vnd.api+json"`. |

Guide: [Adopting the 0.14 surfaces in an existing api](./docs/guides/adopting-0.14.md).

## 1. Resources — the single source of truth

```ts
const Person = Resource.make("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString,
  },
});

const Tag = Resource.make("tags", {
  attributes: { name: Schema.NonEmptyString },
});

const Comment = Resource.make("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Person), // a reference, not a string — typos don't compile
  },
});

const Article = Resource.make("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    createdAt: Schema.DateFromString, // ISO string on the wire, Date in your code
  },
  relationships: {
    author: Relationship.one(() => Person), // required to-one
    editor: Relationship.optional(() => Person), // nullable to-one
    tags: Relationship.many(() => Tag), // bounded to-many, inlined
    comments: Relationship.paginated(() => Comment), // unbounded to-many, linked
  },
});
```

### Relationship kinds

Each relationship declares its cardinality _and_ how its data travels — inline as resource identifiers, or behind a link to a paginated endpoint:

| Constructor | Cardinality | Wire shape of the relationship object | In `?include=` | In create payload |
| --- | --- | --- | --- | --- |
| `Relationship.one` | to-one | `{ data: identifier }` — never null | ✓ | **required** |
| `Relationship.optional` | to-one | `{ data: identifier \| null }` | ✓ | optional |
| `Relationship.many` | to-many | `{ data: identifier[] }` | ✓ | optional |
| `Relationship.paginated` | to-many | `{ links: { related, self? } }` — **no data** | ✗ | ✗ (use relationship endpoints) |

`one` / `optional` / `many` carry **inline linkage**: clients see the related identifiers right inside the parent resource and can pull the full resources into a compound document with `?include=`.

`paginated` is for **unbounded collections** (an article's comments, a user's repositories): the relationship object carries only a required `related` link pointing at a paginated collection endpoint (see [Relationship & related endpoints](#relationship--related-endpoints)).

Paging is only well defined over a stable total order — `first` / `prev` / `next` / `last` denote a sequence of pages, and a cursor _is_ a position in an order — so a `paginated` relationship can declare the **canonical order** its related collection is paged in, in the same `{ field, direction }` terms `?sort=` decodes into:

```ts
const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    comments: Relationship.paginated(() => Comment, {
      // newest first, `id` breaking ties so the order — and any cursor into it — is total
      order: [
        { field: "postedAt", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    }),
  },
});

Resource.relationships(Article).comments.order; // the declared terms
```

Each term names an attribute of the **related** resource, or its `id`; anything else is a compile error, and an empty or repeating order is refused at definition time.

Everything below is **derived** — never assembled by hand:

| Derived | What it is |
| --- | --- |
| `Article` | the resource object `Schema.Struct` itself (`type`/`id`/`attributes`/…) |
| `Article.Id` | branded id schema — `Article.Id` values can't be mixed with `Person.Id` |
| `Article.identifier` | the `{ type: "articles", id }` resource-identifier schema |
| `Article.ref("1")` | a typed identifier _value_ — handy for relationship linkage |
| `Article.localIdentifier` | the `{ type: "articles", lid }` schema — identifies a resource being created (no server id yet) |
| `Article.lidRef("a1")` | a typed local-identifier _value_ — the `lid` counterpart of `ref` |
| `Article.createPayload` | `{ data: { type, lid?, attributes, relationships } }` — no `id`; `one` relationships required, `paginated` relationships and non-`create` [attribute projections](#read-only--per-attribute-projections) excluded |
| `Article.updatePayload` | `{ data: { type, id, attributes? (partial), relationships? } }` — attributes are [tri-state](#update-payloads-set--unset--leave-unchanged); `paginated` relationships and non-`update` [attribute projections](#read-only--per-attribute-projections) excluded |
| `Article.createInput` / `Article.updateInput` | flat ["command-style"](#flat-command-style-payloads) request schemas — attributes (and, for update, the `id`) without the JSON:API envelope |
| `Article.document()` | single-resource document with `Article` as primary `data` (non-null); `included` union derived from the non-paginated relationships |
| `Article.collection()` | collection document (strict array `data`) |
| `typeof Article.Type` | the decoded TypeScript type |

**Undeclared body members.** A write body's `attributes` or `relationships` member rejects every member it doesn't declare, whether it declares fields or none ([#292](https://github.com/thomasfosterau/effect-jsonapi/issues/292)). That covers a member excluded from that write too (`create: false`, `update: false`, `paginated`), and a resource with no attributes or no relationships. It applies to `createPayload`, `updatePayload`, the flat `createInput` / `updateInput` and the atomic `add` / `update` operations. Within a member, each of the first 12 undeclared members is its own 400 error, with `detail` `Expected no excess property` and a `source.pointer` naming the member (`/data/attributes/isAdmin`, `/isAdmin` in a flat payload), and an own `__proto__` or `constructor` is rejected like any other name. If there are more, one further error at the member itself says how many (`detail` `9988 more undeclared members not listed`, `source.pointer` `/data/attributes`; a flat payload's has no `source`, since its member is the whole body). So however many keys a request sends, a member gets at most 13 error objects, 12 plus the summary; an atomic operation's 400 also carries one error for each other resource the operation could have matched. That bounds the number of error objects, not the bytes: each pointer echoes a key name the client sent, so a long name makes a longer error ([#308](https://github.com/thomasfosterau/effect-jsonapi/issues/308)). An empty `{}` is accepted. A value that isn't an object (a string, a number, a boolean, an array, `null`) is a 400 `Expected object` at the member itself (`/data/attributes`). So a member the resource doesn't declare never reaches the handler. The members JSON:API allows around them are untouched: a document's `meta` / `jsonapi` / `links`, a resource object's `meta` / `links`, a relationship's `meta` / `links`, a resource identifier's `meta` and an operation's `meta`.

The check lives in the schemas, so it applies wherever they decode, not only over HTTP: a Standard Schema validator (`Schema.toStandardSchemaV1(Article.createInput)`), a remote function or RPC procedure that decodes the [flat inputs](#flat-command-style-payloads), and `Client.decodeInput` all fail on an undeclared member. Encoding through these schemas, which is what `Client` does with a write body, rejects an undeclared member the same way, before any request is sent. What a rejection reports:

- **One member per request.** `HttpApi` decodes a request body with `errors: "first"`, so it stops at the first member that fails: a body with undeclared members in both `attributes` and `relationships` gets errors for those in `attributes` only. Within that member, the undeclared members up to the cap are reported, and the summary for the rest, whatever `errors` says.
- **The cap is per resource.** `Resource.make(type, { …, maxUndeclaredMemberErrors: 50 })` sets how many undeclared members each of that resource's write body members reports at their own pointers: a positive integer, or `Infinity` to report every one with no summary (anything else throws). It defaults to `12`, `Resource.extend` inherits it (and takes the same option, validated under its own name), a `Resource.family` anchored on a base carries the base's, and `Article.maxUndeclaredMemberErrors` reads it back. It is fixed when the definition is made, so it applies to every write body member above, when decoding and when encoding (`Client`). There is no process-wide setting: to change it everywhere, pass it to each `Resource.make`.
- **A failing declared field first.** The undeclared members are checked once the member's declared fields have parsed. So when a declared field fails (a wrong type, a missing required attribute), only that field is reported, not the undeclared members beside it, even with `errors: "all"`.
- **`Schema.is` and `make` drop it.** For a member that declares fields, `Schema.is(Article.createInput)` answers `true` for a value with an undeclared member, and `Article.createInput.make(...)` strips one: both check the type side, where the struct drops the member before the check sees it. (A member that declares none keeps it there, so `Schema.is` answers `false` and `make` throws.) Validate untrusted input with a decode.

The schemas are still `Schema.Struct`s: `.fields` (`Object.keys(Article.createInput.fields)`) and the OpenAPI request bodies, which list each member's properties with `additionalProperties: false`, are unchanged. A struct you derive from one with `mapFields` (`Struct.pick`, `Struct.omit`, …) is a plain `Schema.Struct` again, which drops undeclared members.

Documents are not limited to one resource type — see [Heterogeneous endpoints](#heterogeneous-endpoints-search-feeds) for polymorphic collections.

### Mutually recursive resources

Relationship references are thunks, so the graph they describe may contain **cycles** — articles linking to their comments and each comment linking back to its article is ordinary JSON:API, and the runtime has always resolved it. What such a pair needs is an explicit **type annotation**: `Resource.make`'s return type is inferred, so without one each definition's type would depend on the other's and TypeScript refuses both (`TS7022`).

The annotation is the same escape Effect's recursive schemas use, and this is all of it — one `interface` per resource in the cycle, naming the relationship record. Hoist the attributes to a `const` so no attribute schema is restated, and give the value the interface of the same name:

```ts
import { Schema } from "effect";
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

const articleAttributes = { title: Schema.NonEmptyString };
const commentAttributes = { body: Schema.NonEmptyString };

interface Article extends Resource.Resource<
  "articles",
  typeof articleAttributes,
  {
    readonly comments: Relationship.many<Comment>;
  }
> {}

interface Comment extends Resource.Resource<
  "comments",
  typeof commentAttributes,
  {
    readonly article: Relationship.one<Article>;
  }
> {}

const Article: Article = Resource.make("articles", {
  attributes: articleAttributes,
  relationships: { comments: Relationship.many(() => Comment) },
});

const Comment: Comment = Resource.make("comments", {
  attributes: commentAttributes,
  relationships: { article: Relationship.one(() => Article) },
});
```

The lowercase `Relationship.one` / `optional` / `many` / `paginated` **types** used in the annotation mirror the constructors of the same name, defaults included (`one` and `optional` default to not filterable, `paginated` to no declared `order`, exactly as the constructors do). A resource definition is invariant in its relationship record, so the annotation has to name the type the constructor produced; these are that type. A relationship that declares a `filter` or an `order` names it too, as the `const` tuple the constructor infers: `Relationship.one<Article, readonly ["eq", "in"]>`.

Self-references work the same way (`parent: Relationship.optional<Category>` on `Category`), and all four relationship kinds may take part in a cycle.

Everything derived from the definitions keeps working, and a cycle cannot make any of it infinite:

| Derived | Behaviour in a cycle |
| --- | --- |
| `Article.document()` | the `included` union is **one hop** wide — the targets of `Article`'s own linkable relationships, not the transitive closure |
| `?include=` paths | bounded by the derivation depth (2 by default, `includePaths(R, n)` at runtime), not by the graph |
| `createPayload` / `updatePayload` | unchanged on both sides — a required `one` across the cycle is still required |
| `Endpoint.get` / `list` / `Group.resource` | derive their paths and documents from the resource's own type tag |

### Custom id schemas

By default a resource's id is `Resource.Id(type)` — a `string` branded by resource type. Pass your own `id` schema (anything whose **encoded** side stays a `string`, so the wire is spec-compliant) to brand ids your way — e.g. an id shared across a hierarchy of types, or one decoded to a richer value:

```ts
const PersonId = Schema.String.pipe(Schema.brand("PersonId"));

const Person = Resource.make("people", {
  id: PersonId, // default = Resource.Id("people")
  attributes: { name: Schema.NonEmptyString },
});

Person.Id; // PersonId
// Person.identifier.Type      → { type: "people"; id: PersonId }
// Person.updatePayload.Type   → data.id is PersonId
// Document.DataDocument(Person).Type.data.id is PersonId
```

The injected id flows through `identifier`, `updatePayload`, `ref`, `createInput`/`updateInput` and the document schemas. Omit `id` and nothing changes — existing definitions keep the auto-branded id. `Resource.Identifier(type, id?)` accepts a custom id too, for standalone identifier schemas.

**Subtype ids via `extend`.** To make a subtype's id a _subtype_ of its base's id — a `PersonId` that _is an_ `AgentId` _is a_ `NodeId` — pass `inheritId: true` to [`extend`](#reusing--extending-resources). The child's id brands the base's id schema, so it accumulates the base's brand(s) and is assignable wherever the base id is expected (transitively through a chain); the reverse is rejected. Effect's brands are intersectional, so this is just brand accumulation:

```ts
const Account = Resource.make("accounts", { attributes: { email: Schema.NonEmptyString } });
const Manager = Resource.extend(Account, "managers", { inheritId: true });

const managerId = Manager.Id.make("1");
const asAccount: typeof Account.Id.Type = managerId; // ✓ a manager id IS an account id
// @ts-expect-error an account id is not a manager id
const asManager: typeof Manager.Id.Type = Account.Id.make("2");
```

`inheritId` defaults to `false` — by default an extended resource gets a fresh, independent brand.

### Update payloads: set / unset / leave unchanged

A PATCH must distinguish three intents per attribute. `updatePayload` models them with `Schema.optional` (`= optionalKey(UndefinedOr(...))`), so each attribute is genuinely tri-state:

| Wire / value   | Meaning           |
| -------------- | ----------------- |
| key **absent** | leave unchanged   |
| key = `null`†  | unset (clear)     |
| key = a value  | set to that value |

† `null` requires a nullable attribute (`Schema.NullOr(...)`). In-process — and over codec transports that preserve it, like RPC / remote functions — an explicit `undefined` is also accepted as "unset". Over a JSON HTTP body, JSON can't carry `undefined`, so `null` is the wire clear signal and an absent key means "leave unchanged".

```ts
const Person = Resource.make("people", {
  attributes: { name: Schema.NonEmptyString, bio: Schema.NullOr(Schema.String) },
});

// Person.updatePayload accepts, for `bio`: a string (set), null (clear), or omit (leave unchanged).
// Its type is `{ name?: string; bio?: string | null | undefined }` under `data.attributes`.
```

### Per-attribute annotations

Stamp metadata onto an attribute with Effect's `schema.annotate({ ... })`, and read it back per attribute with `Resource.attributeAnnotations` — handy for carrying, say, a database column name alongside the attribute schema:

```ts
const Person = Resource.make("people", {
  attributes: { bio: Schema.NullOr(Schema.String).annotate({ dbColumn: "biography" }) },
});

Resource.attributeAnnotations(Person).bio?.dbColumn; // "biography"
```

### Resource-level metadata & introspection

A resource definition is also the natural single source of truth for things _outside_ the HTTP layer — database columns, form descriptors, a sync engine's node definitions. Two accessors make deriving from one a supported thing to do.

**Metadata rides the resource.** A definition _is_ a `Schema.Struct` with its derived members assigned onto it, so Effect's own `resource.annotate({ ... })` rebuilds the schema and returns a plain struct with `type`, `document()`, `createPayload` and the rest gone — no longer a resource, and no longer a valid relationship target. `Resource.annotate` is the seam that keeps it one:

```ts
const TableName = "acme/table"; // namespace your keys

const Person = Resource.annotate(
  Resource.make("people", { attributes: { name: Schema.NonEmptyString } }),
  {
    [TableName]: "people",
  },
);

Person.type; // "people" — still a complete resource
Resource.annotations(Person)[TableName]; // "people"

// still a relationship target, resolved lazily and by identity:
const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: { author: Relationship.one(() => Person) },
});
```

Annotations are inherited by `Resource.extend` (the child's own keys winning), and can be declared up front with `Resource.make`'s `annotations` option — the better spelling when other definitions already point at the resource, since like `Schema.annotate` this returns a _new_ definition rather than mutating the one given.

**Attribute shape is readable.** `Resource.attributeDescriptors` reports what the declaration already knows about each attribute, in declaration order, as plain data — no reaching into `resource.fields.attributes.ast`, no widening the definition through `unknown`, no running a decoder against sentinel values:

```ts
const Article = Resource.make("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    summary: Resource.attribute(Schema.NullOr(Schema.String), { create: "optional" }),
    createdAt: Resource.readOnlyAttribute(Schema.DateFromString),
    draftBody: Resource.attribute(Schema.String, { resource: false, update: false }),
  },
});

Resource.attributeDescriptors(Article);
// [{ key: "title",     schema, resource: "required", create: "required", update: "optional",
//    clearable: false, nullable: false, readOnly: false, annotations },
//  { key: "summary",   …, create: "optional", nullable: true,  clearable: true },
//  { key: "createdAt", …, create: false, update: false, readOnly: true },
//  { key: "draftBody", …, resource: false }]  // input-only: declared, never on the resource object
```

**What belongs in an annotation, and what doesn't.** Annotations are for vocabulary JSON:API has no opinion about — a storage table or column name, a sync-engine node kind, an admin-UI label — so that foreign vocabulary stays out of this package. Metadata that _is_ JSON:API's business gets a declaration instead, because the package has to act on it: filterability is `Filter.able`, sortability is `Sort.able`, and a paginated relationship's [canonical order](#relationship-kinds) is `Relationship.paginated(ref, { order })` — without a stable order the pagination links that relationship advertises are unsound, which is a defect in the document itself. A storage column name, by contrast, has no wire representation at all: two servers that disagree about it serve byte-identical JSON:API documents. That is the test — if changing it changes nothing a client can observe, it is an annotation.

### Read-only & per-attribute projections

By default every attribute is read-write: it appears in the resource object, the documents, and all four write projections (`createPayload` / `updatePayload` / `createInput` / `updateInput`). Some attributes need a different shape — server-set timestamps that are never client input, fields settable only at create time, optional or clearable values. `Resource.attribute(schema, options)` declares that shape per attribute, and `Resource.readOnlyAttribute(schema)` is the common shorthand for "server-set" (`{ create: false, update: false }`).

```ts
const Article = Resource.make("articles", {
  attributes: {
    title: Schema.NonEmptyString, // plain: read-write everywhere
    // server-set: on the resource + in documents, never a write input
    createdAt: Resource.readOnlyAttribute(Schema.Date),
    // settable only at create, never updatable
    slug: Resource.attribute(Schema.String, { update: false }),
    // optional at create, clearable (nullable) on update
    summary: Resource.attribute(Schema.NullOr(Schema.String), { create: "optional" }),
  },
});

// Article.Type.attributes                  → { title, createdAt, slug, summary }
// Article.createPayload … data.attributes  → { title, slug, summary? }   (no createdAt)
// Article.updatePayload … data.attributes  → { title?, summary? }        (no createdAt, no slug)
```

An optional create attribute (`create: "optional"`, or a bare `Schema.optionalKey(...)` attribute) projects as `Schema.optional`, exactly as every update attribute does: the key may be absent, or present with a value or an explicit `undefined`. So a caller that builds `{ summary: input.summary?.trim() || undefined }` type-checks against `createInput` and `updateInput` alike (also under `exactOptionalPropertyTypes`). On a JSON wire an explicit `undefined` and an absent key are the same thing — the attribute is not supplied.

The descriptor options (all optional; the defaults reproduce a plain `Schema` attribute):

| option | values | controls |
| --- | --- | --- |
| `resource` | `true` (default) · `"optional"` · `false` | presence in the resource object schema + documents |
| `create` | `"required"` (default) · `"optional"` · `false` | presence in `createPayload` / `createInput` |
| `update` | `"optional"` (default) · `false` | presence in `updatePayload` / `updateInput` (tri-state when present) |
| `clearable` | `boolean` (default: nullable?) | whether the update projection additionally accepts `null` to clear |

The descriptor rides on the attribute's schema value, so it flows through `attributeKeys`, `attributeAnnotations`, sparse `fields` and `include`, is carried through [`Resource.extend`](#reusing--extending-resources), and is respected by the [atomic operations](#atomic-operations) (`add` mirrors create, `update` mirrors update) — all consistently with the create/update payloads.

#### Write-only (input-only) attributes

`resource: false` declares an attribute that is **accepted as input but never on the resource object** — an upload's binary, a password, a one-time token. It is absent from the resource `Struct`, the documents, `attributeKeys`, sparse `fields`, `filterable` and `sortable`, yet still projected into `createPayload` / `createInput` and `updatePayload` / `updateInput` per its `create` / `update` settings (and into the atomic `add` / `update` operations), so a write-only field stays declared in one place:

```ts
const FileSchema = Schema.Uint8Array; // or any `Schema.declare`d binary

const Upload = Resource.make("uploads", {
  attributes: {
    fileName: Schema.NonEmptyString,
    contentType: Schema.NonEmptyString,
    // create-only binary: in `createInput`, never on the resource object
    file: Resource.attribute(FileSchema, { resource: false, update: false }),
  },
});

// Upload.Type.attributes   → { fileName, contentType }              (no file)
// Upload.createInput.Type  → { fileName, contentType, file }
// Upload.updateInput.Type  → { id, fileName?, contentType? }        (no file — update: false)
Resource.attributeKeys(Upload); // ["fileName", "contentType"]
```

An input-only attribute must keep at least one write projection (`resource: false` with both `create: false` and `update: false` declares nothing) and cannot carry a `filter` / `sort` declaration (it is not on the resource object to filter or sort by); `Resource.make` throws on either, naming the attribute. `Resource.attributes(R)` returns the resource-object map, without input-only attributes; `Resource.declaredAttributes(R)` returns the map as declared, and that is what `Resource.extend` inherits — so a subtype of `Upload` accepts `file` at create too.

The common helpers compose from a single `attribute(...)` call, so you can define your own sugar:

```ts
const computed = <S extends Schema.Top>(s: S) =>
  Resource.attribute(s, { create: false, update: false });
const createOnly = <S extends Schema.Top>(s: S) => Resource.attribute(s, { update: false });
const defaulted = <S extends Schema.Top>(s: S) => Resource.attribute(s, { create: "optional" });
const optional = <S extends Schema.Top>(s: S) =>
  Resource.attribute(s, { resource: "optional", create: "optional" });
const inputOnly = <S extends Schema.Top>(s: S) =>
  Resource.attribute(s, { resource: false, update: false });
```

### Flat (command-style) payloads

Alongside the JSON:API `{ data: { type, attributes } }` payloads, every resource exposes flat request schemas — the attributes alone, no envelope — for transports (RPC, remote functions) that carry a flat shape:

```ts
Person.createInput; // { name, bio }            — flat create attributes
Person.updateInput; // { id, name?, bio? }      — id plus the same tri-state attributes
```

They are closed like the enveloped payloads' members: decoding one, through any transport, fails on a key the resource doesn't declare for that write (see **Undeclared body members** under [Resources](#1-resources--the-single-source-of-truth)).

These are also what the `payload` override on `Endpoint.create` / `Endpoint.update` takes, when the HTTP write contract itself is a flat command input rather than a JSON:API document — see [Overriding the write payload](#overriding-the-write-payload).

### Nullable primary `data`

`Document.DataDocument` is a **pure envelope**: its `data` member is exactly the schema you pass, so nullability is your compositional choice — not something the constructor decides for you. JSON:API only permits `data: null` for a single-resource request whose URL _might_ correspond to a resource but currently doesn't; fetch-existing / create / update always carry the resource (a missing one is a `404`, never `200 { data: null }`).

```ts
Document.DataDocument(Article); //                       data: Article
Document.DataDocument(Schema.NullOr(Article)); //        data: Article | null
Document.DataDocument(Article.nullable()); //            data: Option<Article>, ⇆ null on the wire
```

`Article.nullable()` is `Schema.OptionFromNullOr(Article)` — the spec-clean nullable codec (`None ⇆ null`). Avoid effect's _structural_ `Schema.Option` (`{ _tag, value }`): it serialises a non-conformant body, and `DataDocument` can't tell the two apart. `Article.document()` and `Endpoint.get` / `create` / `update` use the non-null form; `Endpoint.related` for a to-one relationship keeps the nullable form (`data: target | null`) for the empty-linkage case.

### Reusing & extending resources

When several resources share a set of attributes or relationships, define them once and reuse them. `Resource.attributes` / `Resource.relationships` extract a resource's field map and descriptor record so you can spread them into another definition:

```ts
const Profile = Resource.make("profiles", {
  attributes: { ...Resource.attributes(Person), bio: Schema.String },
});
```

`Resource.extend` does the same wholesale — a **subtype** that inherits the base's attributes _and_ relationships, adding (or overriding) its own. JSON:API has no native subtyping, so the result is a _distinct_ resource type: its own `type` tag and branded id, with payloads and documents derived afresh. `meta` is inherited unless overridden.

```ts
const Account = Resource.make("accounts", {
  attributes: { email: Schema.NonEmptyString, createdAt: Schema.DateFromString },
  relationships: { organisation: Relationship.one(() => Organisation) },
});

// `admins` inherits email, createdAt and organisation, adding `permissions`.
const Admin = Resource.extend(Account, "admins", {
  attributes: { permissions: Schema.Array(Schema.String) },
});

Resource.attributeKeys(Admin); // ["email", "createdAt", "permissions"]
```

`extend` accepts a custom `id` schema exactly as `Resource.make` does, for a consumer that keys its subtypes with its own brand catalogue (branding at the row-mapping seam via `AdminId.make(row.id)`). The subtype's id is then that schema and nothing else — no package brand is added — and it flows through `identifier`, `ref`, the payloads and the documents as usual. `id` and `inheritId: true` are contradictory, so passing both is a type error and throws at definition time.

```ts
const AdminId = Schema.String.pipe(Schema.brand("AdminId"));
const Admin = Resource.extend(Account, "admins", { id: AdminId });

Admin.Id.make("1"); // string & Brand<"AdminId">
Admin.ref("1"); // { type: "admins", id: string & Brand<"AdminId"> }
```

### Polymorphic families (heterogeneous supertypes)

`Resource.family` defines a **supertype** over a set of member resources — for a heterogeneous "any node" endpoint, a document whose `data` is the union of subtypes, or a relationship that targets "any member". A family **is** the discriminated union over its members (decoded by the `type` tag) _and_ a first-class resource-like value, so it can be used as primary `data`, as a compound `included` member, and as a **relationship target**.

```ts
const Node = Resource.make("nodes", { attributes: { name: Schema.NonEmptyString } });
const Person = Resource.extend(Node, "people", {
  inheritId: true,
  attributes: { firstName: Schema.String },
});
const Organisation = Resource.extend(Node, "organisations", {
  inheritId: true,
  attributes: { legalName: Schema.String },
});

// Base-anchored family: shared id brand / relationships / attributes come from Node.
const AnyNode = Resource.family(Node, [Person, Organisation]);

AnyNode.document(); // data: Person | Organisation, included spans members' targets
AnyNode.collection(); // data: Array<Person | Organisation>

// As a relationship target — linkage decodes for ANY member (keyed on the member
// `type`, never the family name):
const Edge = Resource.make("edges", {
  attributes: { weight: Schema.Number },
  relationships: { to: Relationship.one(() => AnyNode) },
});
// Edge.to.data is { type: "people"; id } | { type: "organisations"; id }
```

Endpoints: `Endpoint.polymorphic(AnyNode, { include: true })` is the single-resource `GET /nodes/:id` (returning any member), and `Endpoint.collection(AnyNode.members, …)` the `GET /nodes` collection; `Group.make(AnyNode, …)` hosts them.

Two forms:

- **Base-anchored** `Resource.family(Base, [A, B])` — **recommended**. The shared `Id` / `relationships` / attributes come from `Base`, so the shared id brand anchors "any member id" and dotted `?include=` paths _through_ the family are meaningful. Pair with members defined as `extend(Base, …, { inheritId: true })`.
- **Named** `Resource.family("media", [Article, Photo])` — no base; the shared id is a union of the members' ids and the shared relationships/attributes are the by-key intersection of the members'. Fully correct for data / `included` / linkage; include-_through_ and the shared id brand degrade to the intersection.

A family value is data/target-only — it is never _created_, so it deliberately has no `ref` / `createPayload` (only its concrete members do). `Resource.isFamily` distinguishes a family from a single resource or a plain union.

Sparse fieldsets key on the member types, never the family name: an endpoint declaring `fields` whose response can carry a family (`Edge`'s `to`, above) declares `fields[people]` and `fields[organisations]`, and its default document makes those members partial ([#350](https://github.com/thomasfosterau/effect-jsonapi/issues/350)). `fields[nodes]`, the family name, is not declared, since no resource object the response carries has that type: like any undeclared type it is a 400 naming the parameter, and `query.fields` has no `nodes` key. A family nested in another stands for its own members in turn, and a real resource whose type is the family's name (`Node` here, when another relationship targets it directly) is still declared as itself.

## 2. Errors — declared once, spec-compliant forever

```ts
class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
  fields: { id: Schema.String }, // typed fields, round-tripped through the wire
  detail: (e) => `Article ${e.id} not found`,
}) {}
```

One declaration gives you all of:

- a **tagged error class**: `Effect.fail(new ArticleNotFound({ id }))`, `Effect.catchTag("ArticleNotFound", …)`
- a **wire schema** (`ArticleNotFound.wire`) whose encoded form is a JSON:API error document:

  ```json
  {
    "errors": [
      {
        "status": "404",
        "code": "not_found",
        "title": "Resource not found",
        "detail": "Article 42 not found",
        "meta": { "id": "42" }
      }
    ]
  }
  ```

- the **HTTP status** and OpenAPI documentation for free.

`ApiError.BadRequest` (400), `ApiError.NotAcceptable` (406), `ApiError.UnsupportedMediaType` (415), `ApiError.Forbidden` (403) and `ApiError.Conflict` (409) are predefined.

## 3. Endpoints & groups — conventions baked in

```ts
const articles = Group.make(
  Article,
  // GET /articles/:id?include=author,tags&fields[articles]=title
  Endpoint.get(Article, {
    include: true,
    fields: true,
    errors: [ArticleNotFound],
  }),
  // GET /articles?sort=-createdAt&page[offset]=0&page[limit]=10&filter[author]=9
  // (`filter[f]=v` is `eq`, `filter[f]=a,b` is `in`, `filter[f][gt]=v` an operator —
  //  the filter grammar, docs/filter-grammar.md)
  Endpoint.list(Article, {
    include: true,
    sort: ["createdAt", "title"],
    page: Query.Page.Offset,
    filter: { author: Schema.optionalKey(Schema.String) },
    meta: Schema.Struct({ total: Schema.Int }),
  }),
  // POST /articles → 201 (client may send a lid; the required author relationship must be present)
  Endpoint.create(Article, { errors: [TitleTaken] }),
  // PATCH /articles/:id (partial attributes)
  Endpoint.update(Article, { errors: [ArticleNotFound] }),
  // DELETE /articles/:id → 204
  Endpoint.delete(Article, { errors: [ArticleNotFound] }),
  // GET /articles/:id/comments — the paginated related collection
  Endpoint.related(Article, "comments", {
    page: Query.Page.Offset,
    errors: [ArticleNotFound],
  }),
  // PATCH /articles/:id/relationships/author — replace the author
  Endpoint.updateRelationship(Article, "author", { errors: [ArticleNotFound] }),
);

const Api = HttpApi.make("blog").add(articles);
```

### The create's `Location` header

A `201` from `Endpoint.create` carries a `Location` header naming the created resource (JSON:API v1.1 §Creating Resources → 201 Created, a SHOULD). Nothing in the handler sets it: the `Middleware.CreatedLocation` middleware the constructor attaches copies it, verbatim, from the document the endpoint encoded — the created resource's `data.links.self`, or, when the resource has none, the document's top-level `links.self` (a link object contributes its `href`). Give the created resource its own `self` link and the spec's MUST — when the resource carries `links.self`, it and `Location` match — holds by construction:

```ts
// In the `create` handler, once the new `article` is stored:
const self = `/articles/${article.id}`;
// 201, `Location: /articles/42`, and `data.links.self` the same URL
return Effect.succeed(Handlers.data({ ...article, links: { self } }, { self }));
```

With neither link the header is omitted, and so is a link that isn't a URI-reference (a space, a control character or a non-ASCII character in it), rather than sent malformed. Only a `201` is touched: a create answering another [`status`](#overriding-the-write-status) is left alone, as is a response that already carries `Location`, and a body that isn't a JSON document (or isn't settled bytes) passes through unchanged rather than failing the request. The middleware sits inside `Idempotency.Middleware`, so a [replayed](#idempotent-writes-idempotency-key) `201` keeps its `Location`. `Middleware.layer`, `Middleware.layerWith` and `Middleware.layerHostNegotiated` all provide it, and `Registry.layer` / `Registry.webHandler` provide it beneath whatever `middleware` they are given; any other api that composes its own middleware set adds `Middleware.CreatedLocationLive`. The header is not declared on the endpoint, so the typed client does not surface it.

### Overriding the write payload

`Endpoint.create` and `Endpoint.update` bind their request body to the resource's `createPayload` / `updatePayload` — the nested JSON:API envelope — which is what a spec-compliant client sends. Some apis deliberately keep a **flat** write contract instead: a command input carrying foreign-key ids or nested arrays that JSON:API's relationship-linkage model can't express, while still _answering_ with JSON:API documents.

Pass `payload` to supply that schema. It defaults to today's envelope, so existing endpoints are unchanged; only the request body moves — path, params, success document, errors and middleware stay exactly as they were.

```ts
// POST /articles with a flat body: { title, body }
Endpoint.create(Article, { payload: Article.createInput });

// PATCH /articles/:id with a flat body: { id, title?, body? }
// (the payload's `id` stays the validation authority; the path `:id` is the routing key)
Endpoint.update(Article, { payload: Article.updateInput, errors: [ArticleNotFound] });
```

Any schema works, not just the derived projections — reach for your own when the create needs fields the resource doesn't carry:

```ts
Endpoint.create(Article, {
  payload: Schema.Struct({ title: Schema.NonEmptyString, authorId: Schema.String }),
});
```

The same option is available per-endpoint when generating a whole group, so a `Group.resource` call site can adopt flat writes without giving up the generated surface:

```ts
const articles = Group.resource(Article, {
  endpoints: {
    create: { payload: Article.createInput },
    update: { payload: Article.updateInput },
  },
});
```

### Overriding the success document

`Endpoint.get`, `create` and `update` bind their response to the resource's `document()`, and `Endpoint.list` to its `collection()` — the resource is the single source of truth for what a handler returns. Some apis need the response to be a **wire variant** of the resource rather than the resource itself: the assembler stringifies every link before the document leaves the server, so `links.self` is a plain string on the wire, while the resource's own `links.self` is `Document.Link`, which decodes an absolute reference to a `URL`. A generated client then hands every call site a `URL` where it wants a `string`.

Pass `success` to supply that schema. It defaults to today's `document()` / `collection()`, so existing endpoints are unchanged; only the response moves — path, params, query parameters, request payload, errors and middleware stay exactly as they were. Any schema works, exactly as with `payload`: the document envelope is untouched, so `Handlers.offsetPaginationLinks` and the rest of the handler helpers still apply.

With `include` on (`true` or a `Query.IncludeOptions`), the default document's `included` covers every type a legal include path reaches, not only the resource's direct targets (see [Constraining the advertised include paths](#constraining-the-advertised-include-paths)). A hand-written `success` replaces that union with whatever its own `included` admits, and `Document.DataDocument` / `CollectionDocument` admit nothing in `included` unless you pass the union. So an override on an endpoint that advertises `comments.author` must list `Comment` and `Person` itself, or the response for that path fails to encode; the `Group.resource` example below, whose `get` and `list` default to `include: true`, lists what `Article`'s paths reach ([#342](https://github.com/thomasfosterau/effect-jsonapi/issues/342) tracks a public helper that builds the union). On an endpoint that declares `fields`, a hand-written `success` also replaces the default's partial attributes (see [Sparse fieldsets and the default document](#sparse-fieldsets-and-the-default-document)).

```ts
// The wire variant: the resource, with its link members narrowed to plain strings
const WireArticle = Schema.Struct({
  ...Article.fields,
  links: Schema.optionalKey(Schema.Struct({ self: Schema.optionalKey(Schema.String) })),
});

// GET /articles/:id → 200, { data: { …, links: { self: "https://…" } } } — `self` a string
Endpoint.get(Article, { success: Document.DataDocument(WireArticle), errors: [ArticleNotFound] });

// GET /articles → 200, the collection of the same
Endpoint.list(Article, {
  success: Document.CollectionDocument(WireArticle),
  page: Query.Page.Offset,
});
```

The same option is available per-endpoint when generating a whole group, so a `Group.resource` call site can adopt the wire variant without giving up the generated surface:

```ts
const articles = Group.resource(Article, {
  endpoints: {
    // `Group.resource` turns `include: true` on for `get` and `list`, whose paths
    // (`author`, `editor`, `tags`) reach `Person` and `Tag`: list them in `included`.
    get: { success: Document.DataDocument(WireArticle, { included: Schema.Union([Person, Tag]) }) },
    list: {
      success: Document.CollectionDocument(WireArticle, { included: Schema.Union([Person, Tag]) }),
    },
    create: { success: Document.DataDocument(WireArticle) },
    update: { success: Document.DataDocument(WireArticle) },
  },
});
```

### Overriding the write status

`Endpoint.create` answers `201 Created` and `Endpoint.update` `200 OK` — the spec's recommendation for a creation that returns the created resource, and the status `HttpApi` gives any success schema carrying a body. Some apis answer their whole write surface with 200, or accept a write for later application and answer `202`.

Pass `status` to say so. It defaults to today's 201 / 200 — including when `success` is given, which is otherwise re-stamped with the constructor's own — so existing endpoints are unchanged; only the status moves. This is the `status` `Endpoint.delete` already carries, on the write endpoints.

```ts
// POST /articles → 200, the created document
Endpoint.create(Article, { status: 200 });

// PATCH /articles/:id → 202, an update accepted but not yet applied
Endpoint.update(Article, { status: 202, errors: [ArticleNotFound] });
```

The same option is available per-endpoint when generating a whole group:

```ts
const articles = Group.resource(Article, {
  endpoints: { create: { status: 200 }, update: { status: 200 } },
});
```

### Overriding the payload media type

Every body the package declares is `application/vnd.api+json`, request bodies included — and the router matches an incoming `Content-Type` against that registration, answering **415** on a mismatch. That is right for an api that owns its URLs and negotiates §6 itself.

It is wrong for an api whose **host** negotiates instead. Such a host enforces §6 at its own seam — `Middleware.negotiate` is exactly that, reused outside the constructors — and then hands the router a request relabelled `application/json`, because that is what the rest of its URL space speaks. The request the host just admitted would then be 415'd by the router before any handler sees it.

Pass `payloadMediaType` to register the request body under the label the host actually dispatches. It defaults to `application/vnd.api+json`, so existing endpoints are unchanged; the payload schema, the **response** media type, path, params, errors and middleware all stay as they were. Pair it with [`Middleware.layerHostNegotiated`](#4-handlers--typed-in-validated-out), or the package's own §5 check will reject what the host admitted:

```ts
// POST /articles with Content-Type: application/json — the label the host dispatches
Endpoint.create(Article, { payload: Article.createInput, payloadMediaType: "application/json" });

// …the response is still application/vnd.api+json
```

The same option is available per-endpoint when generating a whole group:

```ts
const articles = Group.resource(Article, {
  endpoints: {
    create: { payload: Article.createInput, payloadMediaType: "application/json" },
    update: { payload: Article.updateInput, payloadMediaType: "application/json" },
  },
});
```

Reach for this only when something upstream genuinely enforces §6; on an api that owns its own URLs, the default is the correct — and spec-compliant — choice.

### Overriding the delete response

`Endpoint.delete` answers `204 No Content`, the spec's recommendation for a deletion with nothing further to say. Some apis do have something to say: a **soft delete** marks the row deleted, re-reads it, and returns the tombstone resource so an admin viewer can render what was removed.

Pass `success` to supply that response schema — it defaults to the 204, so existing endpoints are unchanged. The schema is served as `application/vnd.api+json` like every other body in the package, at 200 unless `status` says otherwise; the `:id` path param, errors and middleware are untouched.

```ts
// DELETE /articles/:id → 200, { data: { type: "articles", ... } }
Endpoint.delete(Article, { success: Article.document(), errors: [ArticleNotFound] });

// …or an asynchronous deletion that has been accepted but not yet performed
Endpoint.delete(Article, { success: Article.document(), status: 202 });
```

The same option is available per-endpoint when generating a whole group:

```ts
const articles = Group.resource(Article, {
  endpoints: { delete: { success: Article.document() } },
});
```

### Overriding the read query

`Endpoint.list` composes its query schema from the `include` / `fields` / `sort` / `page` / `filter` options: a flat, bracket-keyed string record on the wire that decodes to the spec's **nested** shape (`page: { offset, limit }`, `filter: { … }`). That is the spec-compliant contract, and the default.

Some apis want a different one — a **flat** list input their operations layer consumes directly, with entity foreign keys and flags JSON:API has no query family for. Forcing such a flag through `filter` would put it on the wire as `filter[includeDeleted]`, which is not what those clients send.

Pass `query` to supply the whole schema. It defaults to today's composition, so existing endpoints are unchanged; the feature options are simply ignored once `query` is given, and the success document, path, errors and middleware stay as they were.

```ts
// GET /articles?page[offset]=20&page[limit]=10&sort=-createdAt&authorId=9&includeDeleted=true
// …decoded flat: { offset, limit, sort?, authorId?, includeDeleted? }
const ListArticles = Query.bracketPageKeys(
  Schema.Struct({
    ...Query.Page.offset({ maxLimit: 100 }),
    sort: Schema.optionalKey(Schema.String),
    authorId: Schema.optionalKey(Schema.String),
    includeDeleted: Schema.optionalKey(Schema.Literals(["true", "false"])),
  }),
);

Endpoint.list(Article, { query: ListArticles });
```

[`Query.bracketPageKeys`](#bracketing-page-keys-on-a-query-struct-you-own) is what keeps the page cursor spec-canonical on the wire (`page[offset]` / `page[limit]`) while the handler still sees `{ offset, limit }` — but any schema works, bracketed or not.

`Endpoint.get` takes the same option, over the `include` / `fields` parameters it composes — for a single-resource fetch carrying a flag JSON:API has no family for, or an `?include=` grammar the api owns rather than derives:

```ts
Endpoint.get(Article, {
  query: Schema.Struct({
    include: Schema.optionalKey(Schema.String),
    includeDeleted: Schema.optionalKey(Schema.Literals(["true", "false"])),
  }),
});
```

Both are available per-endpoint when generating a whole group:

```ts
const articles = Group.resource(Article, {
  endpoints: { list: { query: ListArticles }, get: { query: GetArticle } },
});
```

Note that the package's own `?include=` needs no escape hatch for the **repeated-key** spelling: `?include=author&include=comments` and `?include=author,comments` denote the same set and both decode to it, so a client using either is served identically. Encoding always emits the comma form.

### Generating a whole group from a resource

Writing out every endpoint is explicit, but repetitive — a resource definition already knows its attributes, relationships and graph. `Group.resource` walks that definition and emits the entire group: the CRUD surface plus, for every relationship, the `related` and linkage endpoints appropriate to its kind, with `include` / `fields` / `sort` derived from the graph.

```ts
// CRUD + every relationship endpoint, fully typed — equivalent to spelling out
// get / list / create / update / delete and each relationship endpoint by hand:
const articles = Group.resource(Article, {
  errors: [ArticleNotFound],
  page: Query.Page.Offset,
  // Per-endpoint config overrides the top-level defaults; the keys are the CRUD
  // operations, the values a boolean (emit / omit) or that endpoint's options.
  endpoints: {
    create: { errors: [TitleTaken] },
    list: { filter: { author: Schema.optionalKey(Schema.String) } },
  },
});

// A read-only resource: just get + list, no relationship endpoints:
const people = Group.resource(Person, {
  endpoints: { create: false, update: false, delete: false },
  relationships: false,
});

// Per-relationship config: drop one relationship, re-error another:
const issues = Group.resource(Issue, {
  relationships: {
    comments: false, // omit this relationship's endpoints
    assignee: { errors: [UserNotFound] }, // configure that relationship's endpoints
  },
  // `meta` may be a function, *extending* the resource's base meta rather than
  // replacing it:
  meta: (base) => Schema.Struct({ ...base.fields, total: Schema.Int }),
});
```

Defaults emit all five CRUD operations and every relationship's endpoints with `include` / `fields` / `sort` enabled; `page` and `filter` stay opt-in (their semantics are application-defined), and `errors` is applied to every generated endpoint. Every default is overridable, globally or per endpoint / relationship — see `Endpoint.ResourceOptions`.

For finer control — adding a heterogeneous `search`, dropping or replacing an individual endpoint — `Endpoint.resource` returns the same endpoints as a plain tuple to spread into `Group.make`:

```ts
const articles = Group.make(
  Article,
  ...Endpoint.resource(Article, { errors: [ArticleNotFound] }),
  // …plus anything else this group should serve
  Endpoint.list(Article, {
    name: "search",
    path: "/articles/search",
    filter: { q: Schema.String },
  }),
);
```

### Relationship & related endpoints

The spec defines two URL families per relationship; both are first-class:

| Constructor | Method & path | Payload | Success |
| --- | --- | --- | --- |
| `Endpoint.related` | `GET /<type>/:id/<name>` | — | 200 — the related resource(s) themselves: a single-resource document (to-one) or a collection document with full query support (to-many) |
| `Endpoint.getRelationship` | `GET /<type>/:id/relationships/<name>` | — | 200 — a linkage document (`data` is identifiers, never full resources) |
| `Endpoint.updateRelationship` | `PATCH /<type>/:id/relationships/<name>` | replacement linkage | 200 — the updated linkage |
| `Endpoint.addRelationship` | `POST /<type>/:id/relationships/<name>` | identifiers to add | 200 — the resulting linkage (to-many only) |
| `Endpoint.removeRelationship` | `DELETE /<type>/:id/relationships/<name>` | identifiers to remove | 204 (to-many only) |

Payload and success schemas follow the relationship's kind:

```ts
// `author` is Relationship.one(() => Person):
Endpoint.updateRelationship(Article, "author");
// PATCH payload: { data: PersonIdentifier }          — null doesn't decode (required relationship)

// `editor` is Relationship.optional(() => Person):
Endpoint.updateRelationship(Article, "editor");
// PATCH payload: { data: PersonIdentifier | null }   — null clears the relationship

// `comments` is Relationship.paginated(() => Comment):
Endpoint.related(Article, "comments", { page: Query.Page.Offset, include: true });
// GET /articles/:id/comments?page[offset]=0&page[limit]=10&include=author
// → a paginated collection document of full Comment resources

Endpoint.addRelationship(Article, "comments");
// POST payload: { data: CommentIdentifier[] }

// to-many constructors only accept to-many relationship names:
Endpoint.addRelationship(Article, "author"); // ✗ compile error
```

Handlers return linkage documents with `Handlers.linkage`, and build the relationship URLs with `Handlers.relationshipLink` / `Handlers.relatedLink` / `Handlers.paginatedRelationship`:

```ts
.handle("commentsRelationship", ({ params, query }) =>
  loadComments(params.id, query.page).pipe(Effect.map((comments) =>
    Handlers.linkage(comments.map((c) => Comment.ref(c.id)), {
      self: Handlers.relationshipLink("articles", params.id, "comments"),
      related: Handlers.relatedLink("articles", params.id, "comments")
    })
  )))
```

### Heterogeneous endpoints (search, feeds)

`Endpoint.collection` builds collection endpoints whose `data` mixes several resource types, discriminated by their `type` tags — the natural fit for search results, feeds and timelines. A polymorphic collection has no single owning resource, so `name` and `path` are required:

```ts
const search = Group.make(
  "search",
  // GET /search?filter[q]=bikeshed&include=author&page[offset]=0&page[limit]=10
  Endpoint.collection([Article, Person], {
    name: "search",
    path: "/search",
    filter: { q: Schema.String },
    include: true, // include paths span both resources' graphs
    fields: true, // ?fields[articles]= and ?fields[people]=
    page: Query.Page.Offset,
    meta: Schema.Struct({ total: Schema.Int }),
  }),
);

const Api = HttpApi.make("blog").add(articles).add(search);

// Handlers return mixed collections; clients discriminate on `type`:
for (const result of doc.data) {
  if (result.type === "articles")
    result.attributes.title; // Article
  else result.attributes.firstName; // Person
}
```

The `included` union spans every searched resource's non-`paginated` relationship targets (and, with `include` on, every resource a legal include path reaches), and query features (`fields[TYPE]`, `include`, `sort`) are derived across **all** of the resources in the union.

### Atomic operations

`Endpoint.operations` models the [atomic operations extension](https://jsonapi.org/ext/atomic/): one request carrying an ordered list of operations — creating, updating and deleting resources or their relationships — processed all-or-nothing:

```ts
const operations = Group.make(
  "operations",
  // POST /operations with an atomic:operations document
  Endpoint.operations([Article, Comment], { errors: [OperationFailed] }),
);

const Api = HttpApi.make("blog").add(articles).add(operations);
```

Like everything else, the operations a resource supports are **derived** from its definition — `Atomic.operationsFor(Article)` exposes them as a named record of schemas:

| Derived operation | Wire form |
| --- | --- |
| `.add` | `{ op: "add", data: { type, lid?, attributes, relationships } }` — `one` relationships required, `paginated` excluded |
| `.update` | `{ op: "update", data: { type, id \| lid, attributes?, relationships? } }` — `paginated` excluded |
| `.remove` | `{ op: "remove", ref: { type, id \| lid } }` |
| `.relationships.author.update` (per `one` relationship) | `{ op: "update", ref: { type, id \| lid, relationship }, data: ref }` — never null |
| `.relationships.editor.update` (per `optional` relationship) | `{ op: "update", ref: { type, id \| lid, relationship }, data: ref \| null }` |
| `.relationships.comments.add` / `.update` / `.remove` (per `many` / `paginated` relationship) | `{ op, ref: { type, id \| lid, relationship }, data: [refs] }` |

`paginated` relationships — which carry no inline linkage — are managed exactly this way: their membership is changed through relationship operations (or relationship endpoints), never inside a resource's `relationships` member.

Clients build requests with the typed operation constructors — note the lid refs (`Article.lidRef` / `Comment.lidRef`) linking operations within the same request:

```ts
const doc =
  yield *
  client.operations.operations({
    payload: Atomic.request(
      // 1. create an article; it has no id yet, so it declares a lid.
      //    `author` is a required (`one`) relationship, so it must be present.
      Atomic.add(Article, {
        lid: "a1",
        attributes: { title: "Atomic bikeshedding", body: "…", createdAt: new Date() },
        relationships: {
          author: { data: Person.ref("9") },
          tags: { data: [Tag.ref("1")] },
        },
      }),
      // 2. create a comment...
      Atomic.add(Comment, {
        lid: "c1",
        attributes: { body: "First!" },
        relationships: { author: { data: Person.ref("9") } },
      }),
      // 3. ...and link it into the new article's paginated comments relationship —
      //    both sides referenced by lid
      Atomic.addToRelationship(Article, { lid: "a1" }, "comments", [Comment.lidRef("c1")]),
      // 4. to-one relationship operations replace linkage (`one`: never null)
      Atomic.updateRelationship(Comment, "5", "author", Person.ref("9")),
    ),
  });

doc["atomic:results"]; // one result per operation, in order; `data` is typed Article | Comment
```

Handlers pattern-match over the decoded operation union — the `targetsResource` / `targetsRelationship` guards are curried, so they drop straight into Effect's `Match` module and narrow each case to fully typed `data` / `ref`; `Lid.make()` tracks the server-assigned ids of lid-created resources:

```ts
const OperationsLive = HttpApiBuilder.group(Api, "operations", (handlers) =>
  handlers.handle("operations", ({ payload }) =>
    Effect.gen(function*() {
      const lids = Lid.make()
      const entries = []
      for (const operation of payload["atomic:operations"]) {
        entries.push(Match.value(operation).pipe(
          Match.when(Atomic.targetsRelationship(Article, "comments"), (op) => {
            // op.data is ReadonlyArray<comment ref>; op.op is "add" | "update" | "remove"
            return Atomic.emptyResult
          }),
          Match.when(Atomic.targetsResource(Article), (op) =>
            Match.value(op).pipe(
              Match.when({ op: "add" }, (add) => {
                const id = Article.Id.make(newId())
                const resolved = lids.resolveLinkage(Article, add.data.relationships) // lids → real ids
                const article = Article.make({
                  id,
                  attributes: add.data.attributes,
                  relationships: {
                    // `author` is required (`one`), so the operation always carries it
                    author: { data: lids.identifier(Person, add.data.relationships.author.data) },
                    tags: resolved.tags ?? { data: [] },
                    // `comments` is paginated: new articles start with an empty collection
                    comments: Handlers.paginatedRelationship("articles", id, "comments")
                  }
                })
                if (add.data.lid !== undefined) lids.assign(add.data.lid, article.id)
                return { data: article }
              }),
              Match.when({ op: "update" }, (update) => /* … */),
              Match.when({ op: "remove" }, (remove) => /* … */),
              Match.exhaustive
            )),
          // … one case per resource and relationship; Match.exhaustive proves
          //   every operation in the union is handled
          Match.exhaustive
        ))
      }
      return Atomic.results(entries)
    })))
```

Because the extension uses the JSON:API media type with an `ext` parameter, provide the middleware with the extension declared:

```ts
Layer.provide(Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] }));
```

Every endpoint automatically:

- serves and accepts **`application/vnd.api+json`**
- declares its errors as **JSON:API error documents** at the right status
- carries the **content-negotiation middleware** (415 on parameterised request media types, 406 on unacceptable `Accept` headers) and the **schema-error middleware** (malformed params/query/payloads become JSON:API 400 documents; a handler response that fails its own endpoint's schema stays a server defect — reported, and answered with the opaque JSON:API 500 `ServerErrors.SERVER_ERROR`) — and because they're real `HttpApiMiddleware` services, **the api won't build until you provide them**: forgetting is a compile error, not a runtime surprise
- rejects a **reserved query parameter** it does not process: JSON:API 1.1 reserves parameter names made only of the letters a-z for the specification, so `?unknown=1` (or `?foo[bar]=1` — the family's base name is what counts) is a 400 naming it in `source.parameter`, while an implementation-specific name carrying any other character (`?fooBar=1`, `?x-trace=1`) is ignored as before. Any all-lowercase name the endpoint's `query` schema declares is left to that schema. The specification's own families — `include`, `fields[TYPE]`, `sort`, `page` and `filter` — are a 400 too on an endpoint that doesn't declare them, or declares them with an empty vocabulary, under the specification's general rule for a parameter the server doesn't know how to process ([Query parameters](#query-parameters)); see [Reserved query parameters](#reserved-query-parameters) for the escape hatch for a host's own lowercase names
- documents itself in **OpenAPI** (`OpenApi.fromApi(Api)`) with the JSON:API media type, status codes and bracket query parameters

### Idempotent writes (`Idempotency-Key`)

A `POST` whose response is lost leaves the client unable to tell "it didn't happen" from "it happened and I didn't hear" — retrying duplicates, not retrying loses the write. `lid` does not help: it correlates resources **within** one request, and says nothing about whether the request already ran.

Opt an endpoint in and it accepts an `Idempotency-Key` request header ([the profile](./docs/idempotency.md)):

```ts
const articles = Group.make(
  Article,
  Endpoint.create(Article, { idempotency: true }), // accepts a key
  Endpoint.update(Article, { idempotency: "required" }), // insists on one
);
// …or for a whole generated set:
const people = Group.resource(Person, { idempotency: true });
```

A retry carrying the same key gets the original response back **verbatim** — the same status, headers (a create's `Location` among them) and body, plus `Idempotency-Replayed: true` — instead of running again. The same key carrying a _different_ request is a `422`, never a silent replay; a retry arriving while the original is still in flight is a `409`. Both are JSON:API error documents sourced at the header.

This package stores nothing, so the application supplies the store — the same division `Lid.make()` draws:

```ts
const ApiLive = Layer.mergeAll(ArticlesLive).pipe(
  Layer.provideMerge(Middleware.layer),
  Layer.provideMerge(Idempotency.layer(myStore)), // `Idempotency.Store`: claim / complete / release
);
```

`Idempotency.memoryStore()` implements the contract for tests and single-process development. Opting in attaches a real middleware service, so **the api won't build until the store is provided**.

For the atomic extension, one key covers the **whole request** — the extension's own unit of atomicity — and replays the whole `atomic:results` document, which is what makes a replayed `lid` resolve to the id it resolved to the first time.

JSON:API v1.1 specifies no idempotency mechanism. The header name and the three statuses are the [IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)'s convention; the fingerprint, the replay rule, the key's scope and the retention contract are this package's, published as a profile URI and defined in full in [`docs/idempotency.md`](./docs/idempotency.md).

## 4. Handlers — typed in, validated out

```ts
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      //                 ^ params.id is a branded Article id
      //                         ^ query.include / query.fields are typed & validated
      loadArticle(params.id).pipe(
        Effect.flatMap((article) =>
          // walks `?include=` one level at a time, batched per type
          Handlers.resolveIncluded(article, query.include, targets).pipe(
            Effect.map((included) =>
              Handlers.data(article, { included, self: `/articles/${article.id}` })
            )
          )
        )
      ))
    .handle("list", ({ query }) =>
      // query.sort: [{ field: "createdAt", direction: "desc" }]
      // query.page: { offset?: number, limit?: number }
      listArticles(query).pipe(
        Effect.map(({ items, total }) =>
          Handlers.collection(items, {
            meta: { total },
            links: Handlers.offsetPaginationLinks("/articles", query.page ?? {}, total)
          })
        )
      ))
    .handle("create", ({ payload }) =>
      // payload.data.attributes is fully typed; payload.data.lid is supported
      createArticle(payload.data).pipe(Effect.map((article) => Handlers.data(article))))
    .handle("update", ({ params, payload }) => /* … */)
    .handle("delete", ({ params }) => deleteArticle(params.id))   // void → 204
)
```

The document builders (`Handlers.data` / `Handlers.collection`) enforce the compound-document rules at runtime: `included` is **deduplicated** by `(type, id)` — against itself and against the primary `data`, so a resource that is both a hit and an include target is emitted once, as primary data — and checked for **full linkage** (every included resource must be reachable from the primary data through resource linkage). Any `included` array is emitted, even an empty one or one the dedupe empties — a response to a request carrying `include` MUST have an `included` key, "even if that `included` key holds an empty array" ([§Fetching Includes](https://jsonapi.org/format/1.1/#fetching-includes)) — so pass an array whenever the request carried `include`, and `undefined` when it did not, which omits the member. Their `onResource` option applies per-resource processing — sparse fieldsets, computed `meta` — uniformly across the whole document ([below](#the-per-resource-transform-pass-onresource)).

### Resolving `included` — one batch per level

`Handlers.resolveIncluded` is the other half: the walk that _produces_ `included` from the paths the client requested. It takes the primary data (one resource, or a whole page), the validated `include` paths, and a registry of **batch loaders keyed by resource type** — and nothing else. There is no service to provide and no runtime to set up; it is a plain `Effect` a handler composes.

```ts
// One loader per type. Each is called once per level, with every id that level
// collected — so each is a single `WHERE id IN (…)`, never a lookup per row.
const targets = {
  people: (ids: ReadonlyArray<string>) => db.people.byIds(ids),
  tags: (ids: ReadonlyArray<string>) => db.tags.byIds(ids),
  comments: (ids: ReadonlyArray<string>) => db.comments.byIds(ids),
};

Handlers.resolveIncluded(page, query.include, targets, { concurrency: 4, depth: 2 });
// → Effect<ReadonlyArray<Person | Tag | Comment> | undefined, …>
```

What it guarantees, and why each one matters:

| Property | What it means |
| --- | --- |
| **Batched per level** | Every parent's references for the current segment are collected first, then handed to the loaders as one batch per type. `?include=author.employer` over a 50-article page is **2** loader calls, not 100 — the N+1 this exists to prevent |
| **Deduplicated by `(type, id)`** | `included` is a set of resources, not of references: two paths or two rows reaching the same resource contribute it once, a shared path prefix costs no second query, and a resource already in the primary `data` is never duplicated into `included` |
| **Walk order** | Emission follows the traversal, so `get` and `list` agree and the array is stable whatever order the batches complete in |
| **Cycles terminate** | A graph that loops (`articles → comments → articles`) revisits resources the document already holds, which are never re-loaded |
| **Depth-capped** | `depth` (default `3`, the deepest path `Query.Include` legalises) bounds the number of hops. §7.1 leaves the bound implementation-defined and each hop is another round of loader calls, so this is a denial-of-service boundary, not just an ergonomic one |
| **Unresolvable refs dropped** | A type with no target, an id the batch didn't return, a row this viewer may not see: all normal outcomes, simply absent from `included`. A loader's own failure propagates and fails the document |
| **`undefined` when unasked** | So the builders omit the member. `[]` is the different statement "your walk resolved to nothing" (a bare `?include=`, an empty path list, answers it too), which they emit as `included: []` |

Because every resource is reached _through_ a document resource's linkage, full linkage holds by construction **for the array the resolver returns**: handed unchanged to `Handlers.data` / `Handlers.collection` with the same primary data, the builders' check is a guard over the resolver's own output rather than a live constraint. It is live again when anything between the walk and the document changes linkage, because the check runs on the resources the document actually emits:

- an `onResource` transform that removes or rewrites `relationships` — the check walks reachability from the primary data, so on the primary data it orphans every member reachable only through the primary data's linkage, on an included resource every member reachable only through it, however many hops on (`Handlers.project` and `Handlers.withMeta` leave `relationships` alone; `Handlers.transform` is unconstrained). A member other members still reference is orphaned all the same once the walk cannot reach it: a cycle of members, or a member that references itself, does not link itself to the document;
- editing the array — dropping a member can orphan everything reachable only through it, and an appended resource was never reached at all;
- building the document from different primary data than the walk started from.

So a resolver-built document is not, by itself, a reason to pass `checkLinkage: false`: keep the check on unless you know none of these applies.

Per-viewer visibility rides along for free: every hop loads through the same authorised loader, so the deepest hop of an anonymous caller's walk excludes exactly what their direct read would.

`paginated` relationships carry no inline linkage, so they contribute nothing to a walk — which is why they are excluded from `?include=` paths to begin with.

Pagination links are built with `Handlers.offsetPaginationLinks` (for `Page.Offset`) and `Handlers.numberPaginationLinks` (for `Page.Number`), which emit the spec's `first` / `prev` / `next` / `last` top-level links from the request's page parameters and the total count. Pass the request's other query parameters as `{ query: Query.canonicalPairs(listQuery)(query) }` and every link carries them too ([the canonical query string](#the-canonical-query-string)).

To name the value a builder returns — e.g. on a helper that assembles documents outside a handler — use `Handlers.DocumentValue<Data, Included?, Meta?>` (the runtime shape, with an optional `jsonapi` member) or the schema-derived `Document.Value<R, Included?, Meta?>`, instead of hand-rolling the `{ data, included?, links?, meta?, jsonapi? }` envelope.

To serve it (with `@effect/platform-node`):

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(ArticlesLive),
  Layer.provide(Middleware.layer) // content negotiation, JSON:API 400s, a 201's `Location`
)

// rc.118 builds a fresh router per entrypoint: serve the API layer through
// `HttpRouter.serve` (or `toWebHandler`), not through a router you provide.
HttpRouter.serve(ApiLive).pipe(
  Layer.provide(NodeHttpServer.layer(...)),
  Layer.launch,
  NodeRuntime.runMain
)
```

If you negotiate content outside `HttpApi` — say in a framework hook that owns the URL — `Middleware.negotiate(headers, options?)` runs the §5 rules standalone, returning the offending `ApiError` (`UnsupportedMediaType` / `NotAcceptable`) or `undefined`, and `ApiError.toDocument(error)` renders any `ApiError` to a JSON:API error-document value:

```ts
const error = Middleware.negotiate({
  contentType: request.headers.get("content-type") ?? undefined,
  accept: request.headers.get("accept") ?? undefined,
});
if (error) {
  const body = ApiError.toDocument(error); // { errors: [{ status, code, title }] }
  // → respond with `Number(body.errors[0].status)` and `body`
}
```

`Middleware.schemaError(part)` is the other half: the JSON:API **400** a request-validation failure produces, standalone. It's the same value the `SchemaErrors` middleware raises inside `HttpApi`, so a hook that decodes requests with its own schemas answers byte-identically to an `Endpoint`-built api:

```ts
const parsed = Schema.decodeUnknownExit(ListQuery)(params);
if (parsed._tag === "Failure") {
  return json(400, ApiError.toDocument(Middleware.schemaError("Query")));
}
```

#### When the host already negotiated

If you _do_ adopt the endpoint constructors but your host negotiates content upstream — a framework hook serving JSON:API and HTML on one URL space — the constructors' `ContentNegotiation` middleware would run §5 a second time. That's redundant at best, and contradictory when the host deliberately admits something the spec's rules reject (an api that accepts `Accept: application/json` would see those requests 406'd after the hook let them through).

`Middleware.layerHostNegotiated` is the drop-in replacement for `Middleware.layer` in that case: it satisfies the endpoints' `ContentNegotiation` requirement without performing any checks, leaving the host the single negotiating authority, and keeps `SchemaErrors` live so request validation still answers with JSON:API 400s (and `CreatedLocation`, so a create's `201` still carries `Location`). Nothing else about the endpoints changes.

```ts
HttpApiBuilder.layer(Api).pipe(
  Layer.provide(ArticlesLive),
  Layer.provide(Middleware.layerHostNegotiated), // the hook ran `Middleware.negotiate` already
);
```

Use it only when something upstream genuinely enforces §5 — for an api that owns its own URLs, `Middleware.layer` remains the correct choice. (`Middleware.ContentNegotiationPassthrough` is the negotiation half alone, for composing your own set.)

#### Reserved query parameters

The `SchemaErrors` middleware rejects, with a 400 per offending parameter, every query parameter whose family base name is made only of a-z and that the endpoint's `query` schema doesn't declare — the spec's MUST, which reserves those names so it can standardise more later. That includes the specification's own families on an endpoint that doesn't support them ([Query parameters](#query-parameters)), each with its own detail. A host whose URL space carries its own lowercase parameters through to the api (`?lang=`, `?ref=`) can either rename them (`langCode`, `x-ref` — the spec's recommendation) or list them, by family base name:

```ts
Layer.provide(Middleware.layerWith({ allowedQueryParameters: ["lang"] }));

// or, when the host negotiates content itself:
Layer.provide(
  Layer.mergeAll(
    Middleware.ContentNegotiationPassthrough,
    Middleware.schemaErrorsLayer({ allowedQueryParameters: ["lang"] }),
    Middleware.CreatedLocationLive, // the create's `Location` header
  ),
);
```

Each entry must be such a base name: `lang[region]`, `Lang`, ` lang` or `""` throws `Middleware.InvalidAllowedQueryParameter` when the layer is built, rather than silently admitting nothing (list a bracketed member by its base name; a name with any other character is never rejected, so it needs no entry). So does a family the specification defines — `include`, `fields`, `sort`, `page` or `filter` — and any bracketed name of one, such as `page[size]`: an endpoint supports a family, or a `fields`, `page` or `filter` member, by declaring it in its `query` schema, and answers 400 when it doesn't, under the specification's general rule (§Implementation-Specific Query Parameters: if "the server does not know how to process it as a query parameter from this specification, it **MUST** return `400 Bad Request`"; see [Query parameters](#query-parameters)). JSON:API defines only the bare `include` and `sort`, so the refusal of an `include[]` or `sort[title]` entry says so; one of a name that only starts like a family's (`page[`, `page[size`, `filter[_]`) says it is no member of the family. The allow-list can't switch that 400 off, so a spec family is never silently ignored ([#261](https://github.com/thomasfosterau/effect-jsonapi/issues/261)).

An allowed name never reaches the endpoint's decoded `query`, which keeps only what its `query` schema declares — also when that schema declares nothing ([#260](https://github.com/thomasfosterau/effect-jsonapi/issues/260)); it is only no longer rejected. `Middleware.checkQueryParameters(names, { declared, allowedQueryParameters })` is the same check standalone, for a hook that decodes requests itself: it returns the 400 document, or `undefined`.

And to call it — the same definitions drive a fully typed client:

```ts
import { Client } from "@thomasfosterau/effect-jsonapi"

const client = yield* Client.make(Api, { baseUrl: "http://localhost:3000" })

const doc = yield* client.articles.get({
  params: { id: Article.Id.make("1") },
  query: { include: ["author"] }     // ← include paths are typed literals; typos don't compile
}).pipe(
  Effect.catchTag("ArticleNotFound", (e) => /* e.id is typed */ …)
)
// doc.data.attributes.createdAt is a Date; doc.included is typed
```

`Client.make` is `HttpApiClient.make` with JSON:API content negotiation applied: `Accept: application/vnd.api+json` on every request, and `Content-Type` on every mutating one — including a bodyless `DELETE`, which carries no body to label but is still negotiated on. A client derived by `HttpApiClient.make` alone sends neither, so it does not meet the spec's client responsibilities and a host serving HTML and JSON:API on one origin has nothing to select on. An api using extensions takes the same `extensions` value the server's `Middleware.layerWith` is given:

```ts
const client =
  yield *
  Client.make(Api, {
    baseUrl: "http://localhost:3000",
    extensions: [Atomic.EXTENSION_URI], // ← the same value `Middleware.layerWith` gets
  });
```

The pieces are public individually, for transports that are not a derived client: `Client.transform` applies the negotiation to any `HttpClient`, `Client.jsonApiHeaders` to a single request, `Client.mediaType(options)` builds the header value, and `Client.isMutatingMethod` is the `POST` / `PATCH` / `PUT` / `DELETE` predicate — exported because which requests carry a `Content-Type` is a correctness detail that a façade and a server must not answer differently.

### The per-resource transform pass (`onResource`)

A document carries the same resource type in more than one slot: primary `data`, every `included` member, the identifiers of a relationship document. Per-resource processing that only reaches one of them — a sparse fieldset projected out of `data` but not out of `included`, per-viewer `meta` stamped on one but not the other — leaves a document describing one type two different ways. Sparse fieldsets in particular are specified to apply to **every** resource of that type in the document.

`onResource` is one pass over all of them:

```ts
Handlers.data(article, {
  included,
  self: `/articles/${article.id}`,
  onResource: Handlers.compose(
    Handlers.project(query.fields), // ?fields[articles]=title
    Handlers.withMeta((r) => permissions(viewer, r)), // { canEdit, canDelete }
  ),
});
```

It runs **once per resource** — after `included` is deduplicated (so once per distinct resource, not once per occurrence) and before the full-linkage check (so the check sees what the document actually emits). A resource reached in two slots is shaped once and that result reused, so it cannot come out two ways. Transforms must therefore be pure functions of the resource, and must not change its `type` or `id`.

The same option is on `Handlers.collection`, on `Handlers.linkage` (where it reaches the resource identifiers §8.4 makes a relationship document's primary data), and on `Handlers.buildIncluded`.

| Transform | What it does |
| --- | --- |
| `Handlers.project(fields)` | Sparse fieldsets: narrows `attributes` to the names requested for the resource's type. |
| `Handlers.withMeta(compute)` | Merges computed `meta` over the resource's own. |
| `Handlers.compose(first, second)` | One pass doing both. |
| `Handlers.transform<Lambda>(f)` | Anything else, with its type-level effect declared. |

`Handlers.project` also has a data-first form, `Handlers.project(resource, fields)`, for projecting one resource directly. Two behaviours make it safe to run over a whole document: a type with **no requested set** (absent, or an empty `?fields[TYPE]=`) is returned unchanged — the spec's default of "every field", not "no field" — and only `attributes` is projected, so `relationships`, `links` and `meta` survive and a resource identifier (no attributes at all) passes through untouched.

#### Sparse fieldsets and the default document

An endpoint that declares `fields` binds, by default, a document whose resource objects admit **any subset of their attributes**: the primary data and every `included` member of a type a `fields[TYPE]` can name — the resource, its non-`paginated` direct targets (unless `include` is a declared `Include.Surface`) and every type a legal include path reaches, the set `Query.FieldsetResources` computes. A family in `data` or `included` stands for its members (recursively, for a family nested in another), each made partial under its own type ([#350](https://github.com/thomasfosterau/effect-jsonapi/issues/350)). Every attribute becomes an optional key; one that is already optional stays as declared, and `type`, `id`, `relationships`, `links` and `meta` are untouched. That is what lets a handler answer with `Handlers.project(query.fields)` with no cast, and what lets the answer to `?fields[articles]=title` omit `body`, as §Sparse Fieldsets requires ("an endpoint **MUST NOT** include additional [fields]"). It holds for `get`, `list`, `related`, `collection` and `polymorphic`, and for the `get`, `list` and related endpoints `Endpoint.resource` / `Group.resource` generate, which declare `fields` by default. An endpoint without `fields` keeps exactly the document it had.

```ts
const articles = Group.make(Article, Endpoint.get(Article, { include: true, fields: true }));

HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers.handle("get", ({ params, query }) =>
    loadArticle(params.id).pipe(
      Effect.map((article) =>
        // GET /articles/1?fields[articles]=title → { data: { …, attributes: { title: "…" } } }
        Handlers.data(article, { included, onResource: Handlers.project(query.fields) }),
      ),
    ),
  ),
);
```

**What a client sees.** An endpoint has one success schema, which is both what the handler encodes and what `HttpApiClient` decodes into, so on an endpoint declaring `fields` the client reads those attributes as optional: `doc.data.attributes.title` is `string | undefined`, whether or not the request asked for a fieldset. A complete resource decodes as before; a projected one decodes instead of failing.

**Keeping strict attributes.** When every caller wants every attribute, leave `fields` off: `fields: false`, which `Group.resource` / `Endpoint.resource` take at the top level or per endpoint. The endpoint then binds the strict document it would have without `fields`, and `?fields[TYPE]=` is a 400 rather than an answer the client cannot trim.

Keeping `fields` and passing a strict `success` also works, at two costs. First, the handler must not project, so a request for a fieldset is answered with every attribute, including those the client excluded. Second, `success` replaces the whole default document, and `Article.document()` (`Article.collection()` for `list`) equals the strict default only while `include` is off and the endpoint's `meta` is not overridden. With `include` on, which is the `Group.resource` default, its `included` admits only `Article`'s direct targets, not every type an include path reaches, and an endpoint `meta` option no longer applies. The override must then reproduce both: `Article.document({ included: Schema.Union([...]), meta })`, listing every type `Article`'s include paths reach (see [Overriding the success document](#overriding-the-success-document); [#342](https://github.com/thomasfosterau/effect-jsonapi/issues/342) tracks a public helper that builds the union).

`Handlers.withMeta` merges the computed members over whatever `meta` the resource already carries, and emits **no** `meta` member when the merged result is empty: to the spec an empty `meta` object is a present-but-empty meta, which says something different from saying nothing.

#### The effect stays in the type

The builders' return type is computed from the transform rather than widened:

```ts
const document = Handlers.data(article, {
  included: [otherArticle],
  onResource: Handlers.project({ articles: ["title"] }),
});

document.data.attributes; // { title: string } — `body` is gone
document.included?.[0]?.attributes; // { title: string } — and gone here too, identically
```

A fieldset known only at runtime (`query.fields`) can be any subset of the selectable names, so each projected attribute is typed as optional — honest in both directions rather than claiming a selection the request may not have made.

Because one transform is applied at several types in a single document, its effect cannot be a single inferred return type; it is carried by a type-level function. To write your own, declare the lambda and hand it to `Handlers.transform`:

```ts
interface SelfLinkLambda extends Handlers.TransformLambda {
  readonly Out: this["In"] & { readonly links: { readonly self: string } };
}

const withSelfLink = Handlers.transform<SelfLinkLambda>((resource) => ({
  ...resource,
  links: { self: `/${resource.type}/${resource.id}` },
}));
```

A plain function is accepted too, and is checked against `Handlers.IdentityLambda`: it must hand back the resource's own type, which is exactly the guarantee a shape-preserving transform makes.

One consequence is worth stating plainly: a projected document is deliberately _not_ the endpoint's default response-document type. A resource with attributes removed no longer satisfies a schema that requires them, and the type says so rather than pretending otherwise. On an endpoint that declares `fields` the default document admits the projection (see [Sparse fieldsets and the default document](#sparse-fieldsets-and-the-default-document)); any other endpoint that projects needs a success document that does — see [Overriding the success document](#overriding-the-success-document) — built over a resource variant whose attributes are optional.

### Narrowing `included` by the requested include paths

The spec guarantees that a server "MUST NOT include unrequested resource objects", so the client knows _statically_ what `included` can contain — `Client.narrowIncluded` exposes that:

```ts
const include = ["author"] as const;

const doc =
  yield *
  client.articles
    .get({
      params: { id: Article.Id.make("1") },
      query: { include },
    })
    .pipe(Client.narrowIncluded(Article, include));

doc.included;
// ^ ReadonlyArray<Person> — not Person | Comment | Tag.
//   doc.included[0].attributes.firstName is accessible without narrowing on `type`.
```

Dotted paths include the intermediate resources (`["comments.author"]` → `Comment | Person`), and requesting nothing narrows `included` to `never`. This is a type-level operation with no runtime cost; the response is still decoded against the endpoint's full schema, so a non-compliant server fails loudly instead of lying.

### Reading error documents

A failure the api declares arrives as its typed error (`Effect.catchTag` above). A failure it does not — an opaque 5xx, a gateway's HTML, a truncated body — arrives as an `HttpClientError`, and `Client.errorDocument` reads whatever JSON:API error document it carries:

```ts
const message =
  yield *
  Effect.map(Client.errorDocument(cause), (document) =>
    Option.match(document, {
      onNone: () => "The server could not be reached",
      onSome: Client.errorMessage, // first `detail`, else `title`, else a constant
    }),
  );
```

The decode is genuinely best-effort: a non-conforming body degrades to `Option.none()` rather than throwing a second error inside the error path. `Client.decodeErrorDocument(body)` is the same decoder reached from a **body** rather than a response — a supported entry point, not an internal of the cause-based one — so a façade that synthesises responses locally and never holds an `HttpClientError` decodes through exactly the same seam as the network transport. That is what makes a façade-served error and a network-served error for the same URL indistinguishable to the client. A worked client is in [`examples/blog/client.ts`](./examples/blog/client.ts).

### The client helpers: error responses, hydration, page cursors

The consuming side of a JSON:API `HttpApi` grows the same handful of helpers in every application: a client whose failures arrive decoded, readers for the collection document's page math, a resolver from relationship linkage to the `included` resources behind it, and the `page[offset]` / `page[limit]` cursor a list page carries in its own URL. `Client` carries them.

```ts
import { Effect, Option } from "effect";
import { Client } from "@thomasfosterau/effect-jsonapi";

// Every call the server answered with an error response fails as a decoded
// `Client.ErrorResponse` — status, message, the error document when there was
// one — instead of the raw HttpClientError. Transport faults pass through.
const client = yield * Client.make(Api, { baseUrl: "https://example.test", decodeErrors: true });
const people =
  yield *
  client.people
    .list({ query: { limit: 10, offset: 0 } })
    .pipe(
      Effect.catchTag("ErrorResponse", (error) =>
        Effect.fail(new PageError({ status: error.status, message: error.message })),
      ),
    );

// the page math, from the real unpaged total the server reports
const total = Client.readTotalCount(people); // meta.totalCount, 0 when absent
const more = Client.hasNextPage(0, 10, total); // correct at an exact multiple of the page size
```

`Client.hydrate` resolves a document's linkage against its `included` member, typed by the resource definition: a to-one relationship is an `Option` of its target, a to-many an array in linkage order, a dotted path — the two-hop `authors.contributor` shape, where the middle resource is a relator carrying the credit's shape rather than a name — resolves to the resources at the end of it. A ref the include walk didn't hoist (or the viewer may not see) is skipped, never a failure, so `included` is legitimately a subset of the linkage.

```ts
const book = Client.hydrate(Book, document); // `included` indexed once
const authors = book.walk("authors.contributor"); // ReadonlyArray<Person>, deduplicated
const publisher = book.related("publisher"); // Option<Person>
```

The page cursor is one reader and a few href builders, so no page hands a user-controlled number onward unbounded and no filtered list drops its filter on page 2:

```ts
const cursor = Client.readPageCursor(url, { defaultLimit: 24, maxLimit: 100 }); // { offset, limit }, clamped
const href = Client.filteredPageHref("/people", { q }); // href(offset): bare path on page 1
const next = Client.canonicalPageHref("/people", pairs, { offset: 24, limit: 24 }); // the server's own link spelling
const window = Client.pageWindow(cursor, total); // first, last, siblings, gaps — for the control to render
```

## 5. The server skeleton

Three applications built on this package each grew the same two thousand lines on top of it: an error catalogue and the seam that turns a failure into an error document, a content-negotiation verdict for an api that shares its URLs with rendered pages, a document assembler that stamps per-viewer `meta` and stringifies links, a handler factory over "the operations", and a registry that checks every family against its group at module init. That scaffolding lives here now, as the modules below. Each is optional — an api built from `Group.make` and `HttpApiBuilder` directly never meets them — and each is generic in what an application owns: its viewer, its transaction boundary, its cache, its database's errors.

### The flat contract

A _flat_ contract is one whose list inputs are one struct the rest of the application consumes directly — `{ limit, offset, status, sort }` — and whose write payloads are flat command inputs rather than the JSON:API envelope. `FlatQuery` is the grammar such a struct is built from (bounded pagination with decoding defaults, the `?sort=` string in both wire spellings, a `filter[ids]` list, a slug attribute), `Query.flatList` puts it on the wire, and `Group.flat` / `Group.flatReadOnly` derive the standard endpoint set from it:

```ts
import { FlatQuery, Group, Include, Resource } from "@thomasfosterau/effect-jsonapi";

const ListPeople = FlatQuery.listInput({ maxLimit: 100 }, { q: Schema.optionalKey(Schema.String) });
//    { offset: 0, limit: 50, sort?: SortField[], q?: string } once decoded

const { group: peopleGroup, listQuery: peopleListQuery } = Group.flat({
  resource: Person,
  list: ListPeople,
  filters: ["q"], // ?filter[q]= on the wire, `q` once decoded
  include: Include.make(Person, { birthPlace: Place }),
  create: CreatePerson,
  update: UpdatePerson, // carries `id`; a mismatch with `:id` is the 409
});
// GET /people        → 200 collection, ?page[offset]= ?page[limit]= ?filter[q]= ?include=
// GET /people/:id    → 200 document,   ?include=
// POST /people       → 201, PATCH /people/:id → 200 (declares 409), DELETE /people/:id → 204
```

The documents the endpoints declare are the **wire** form of the resource (`Document.wire`: string links, since the assembler stringifies every `URL` it is handed), and the `listQuery` handed back beside the group is what the collection handler spells its pagination links from — the same schema the endpoint decodes, so a link's query and a request's query cannot drift. `Endpoint.flatRelated` is the §7.4 related-resource endpoint in the same style, for a longhand group.

### The error seam

`ServerErrors` holds the catalogue an operation fails with (`NotFound`, `Unauthorized`, `Forbidden`, `Redirect`, `HttpError`, `ValidationFailure`), the `JsonapiError` carrier for a one-off, and `fromTaggedError`, which maps any of them — and any `ApiError.make` class, `ApiError.Conflict` and the package's own include / sort errors included — to its error document. `respond` wraps a handler with it:

```ts
import { Option } from "effect";
import { ServerErrors } from "@thomasfosterau/effect-jsonapi";

const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  ServerErrors.respond(effect, {
    // the arms only the application can recognise — a driver's unique violation, say
    materialise: (cause) =>
      isUniqueViolation(cause)
        ? Option.some(
            new ServerErrors.JsonapiError({
              status: 409,
              errors: [{ status: "409", code: "conflict" }],
            }),
          )
        : Option.none(),
  });
// NotFound → 404 not-found · Forbidden → 403 auth.forbidden · ApiError.Conflict → 409 conflict
// anything unmapped → logged, then an opaque 500 `internal`
```

### The negotiation verdict

An api on bare resource URLs shared with its pages decides, per request and before any routing, whether `/people/1` answers a page or a document. `Negotiation.make({ api })` derives the route table from every endpoint the api declares and answers that from the request line and headers alone, so a web front door and the api it forwards to share one verdict:

```ts
import { Negotiation } from "@thomasfosterau/effect-jsonapi";

const { isApiPath, negotiate } = Negotiation.make({ api: Api });

// in the framework hook:
const verdict = negotiate(request);
if (verdict.error) return Negotiation.errorResponse(verdict.error); // JSON:API §5 406 / 415, or the opt-in RFC 9110 refusal 406
if (verdict.dispatch) return apiHandler(Negotiation.requestForRouter(request), context);
// otherwise render the page; `verdict.representation` is the cache-key token
```

A read dispatches when a clean JSON:API instance wins `Accept`; a write when its `Content-Type` is the JSON:API media type; a browser navigation, an `application/json` client and a bare `*/*` all fall through. Pair it with `Middleware.layerHostNegotiated` on the api side, which leaves the host the single negotiating authority.

A read whose `Accept` refuses JSON:API outright (`application/vnd.api+json;q=0`) and names nothing else acceptable falls through too, by default — RFC 9110 reads `q=0` as "not acceptable", so the JSON:API instance just doesn't win. A host that would rather answer that client a 406 opts in:

```ts
const { negotiate } = Negotiation.make({ api: Api, onExplicitRefusal: "notAcceptable" });
const read = (accept: string) =>
  new Request("https://example.test/people", { headers: { accept } });

negotiate(read("application/vnd.api+json;q=0")).error; // Negotiation.NOT_ACCEPTABLE_REFUSED (406)
negotiate(read("application/vnd.api+json;q=0, text/html;q=0.5")); // the page, as before
negotiate(read("application/vnd.api+json;q=0, application/json")); // the page, as before
```

The refusal applies only when no range of any media type carries `q > 0`; another range — `text/html`, `application/json`, `*/*`, an alternate, another JSON:API instance — is negotiated as without the option. `NOT_ACCEPTABLE_REFUSED` shares `NOT_ACCEPTABLE`'s status and `code`; its `detail` names the RFC 9110 rule rather than the §6.3.2 media-type-parameter one, so the two 406s can be told apart.

### The assembler, the handlers and the registry

`Assemble.resource` / `Assemble.collection` are the seam a handler's document returns go through: capability `meta` (`canEdit` / `canDelete`, computed per resource by a hook — `roleCapabilities`, `ownedCapabilities`, or your own), links stringified, fieldsets projected, the `include` walk validated and resolved batched through a `Handlers.IncludeTargets` registry, the `jsonapi` member set. A request carrying `include` always gets the `included` key — `[]` when nothing resolved or every candidate was already primary data. Presence is the signal: a bare `?include=` decodes to `[]` and is a request carrying `include` too. Without `include` the key is absent unless members the caller resolved itself survive the dedupe. `ResourceHandlers.related` answers an empty to-one the same way: `{ data: null, included: [] }` when the request carried `include`, its paths validated (`400` for one outside the whitelist) though there is nothing to walk from.

`Assemble.collection(resources, pagination, options?)` surfaces the page math — `meta.totalCount` and the five offset pagination links, carrying the request's other query pairs. A collection served whole (a small fixed list, or a to-many related collection that is never paged) uses `Assemble.unpaginatedCollection(resources, options?)` instead: the same stamping, projection, `include` walk, `included` handling and `jsonapi` member, with no pagination `links` (and no `links` member at all unless `self` is given) and no `meta` (unless `meta` is given) — and its `UnpaginatedCollectionDocument` type has no page math and no pagination links, so no `meta.totalCount` and no `next` / `last` link the endpoint doesn't honour is advertised:

```ts
const document = Assemble.unpaginatedCollection(colours, {
  include: ["family"],
  includable: ["family"],
  targets: { families },
});
// Effect<UnpaginatedCollectionDocument<Colour>, …>
// succeeds with { data: [...], included: [...], jsonapi: { version: "1.1" } }
```

To give the collection its own `self` link, pass `self` (its absolute URL) and, optionally, `query` — the request's canonical pairs (`Query.canonicalPairs(listQuery)(query)`), serialised onto `self` the way `Assemble.collection` serialises them onto its pagination links. The document then carries `links: { self }` and still no `meta`; the return type follows the `self` you pass (`links` required for a `string`, optional for a `string | undefined`), and `query` is a type error without `self`. With no `self` the output is exactly as above:

```ts
const document = Assemble.unpaginatedCollection(colours, {
  self: "https://example.test/colours",
  query: Query.canonicalPairs(listQuery)(query),
});
// Effect<UnpaginatedCollectionDocument<Colour, string>, …>
// succeeds with { data: [...], links: { self: "https://example.test/colours?sort=name" }, jsonapi: … }
```

Document-level metadata that isn't page math (a generation timestamp, a cache hint, an application-specific summary) goes in `meta`, which the document carries as given. The return type follows it the way it follows `self`: `meta` of the type you pass, optional when that type admits `undefined` (your own optional `meta` forwarded as is), and no `meta` member at all without it. An object literal keeps its literal type (`meta` is inferred `const`, as on `Handlers.collection`, since the document emits that very value), and a value typed by an `interface` with no index signature is rejected, as `Handlers.collection` rejects it: spread it (`{ ...stamp }`) or use a `type` alias. `meta.totalCount` gets no special treatment: it is emitted verbatim, and with `self` makes the document structurally assignable to `CollectionDocument`. A collection whose total matters is a page, and goes through `Assemble.collection`:

```ts
const document = Assemble.unpaginatedCollection(colours, {
  self: "https://example.test/colours",
  meta: { generatedAt: snapshot.takenAt },
});
// Effect<UnpaginatedCollectionDocument<Colour, string, { readonly generatedAt: string }>, …>
// succeeds with { data: [...], links: { self: … }, meta: { generatedAt: "…" }, jsonapi: … }
```

`ResourceHandlers.make` / `readOnly` build the handler set the presets' endpoints expect, with everything an application owns passed in; `Registry` collects the families, checks each against its group at module init, and builds the router:

```ts
import { Assemble, Registry, ResourceHandlers } from "@thomasfosterau/effect-jsonapi"

const peopleFamily = {
  group: "people",
  handlers: ResourceHandlers.make({
    segment: "people",
    listQuery: peopleListQuery,                    // the family's own list query, for the links
    linkBase,                                      // Effect<string>: the absolute origin
    viewer,                                        // Effect<User | null>: the request's viewer
    capabilities: Assemble.roleCapabilities((user) => user?.role === "admin"),
    transact,                                      // the boundary every write runs inside
    cache,                                         // read-through on get, write-through on writes
    include: { includable: PERSON_INCLUDE.paths, targets },
    ops: { list, get, create, update, delete },    // the application's Effect-native operations
  }),
} satisfies Registry.FamilyFor<typeof peopleGroup>  // every handler's success channel checked
                                                    // against its endpoint's declared document

const { handler } = Registry.webHandler(Api, [peopleFamily, contestsFamily], {
  respond: boundary,
})
// (request: Request, context: Context<User | Database | …>) => Promise<Response>
```

## Query parameters

| Family | Wire form | Decoded form |
| --- | --- | --- |
| `include` | `?include=author,comments.author` | `ReadonlyArray<"author" \| "comments" \| "comments.author">` — literal paths from the relationship graph ([constrainable](#constraining-the-advertised-include-paths)) |
| `fields[TYPE]` | `?fields[articles]=title,body` | `{ articles?: ReadonlyArray<"title" \| "body" \| …> }` — closed per-type key sets |
| `sort` | `?sort=-createdAt,title` | `[{ field: "createdAt", direction: "desc" }, …]` |
| `page[*]` | `?page[offset]=0&page[limit]=10` | `{ offset?: number, limit?: number }` (`Page.Offset`, `Page.Number`, `Page.Cursor`, or custom) |
| `filter[*]` | `?filter[status]=open&filter[age][gt]=18` | `Filter.Ast` — one root node over the declared fields ([the filter grammar](./docs/filter-grammar.md), `filter: true`); fails closed on undeclared fields, operators and literals. Or a user-defined schema per key (`filter: { q: … }`) |

Unknown include paths, unknown sparse-fieldset names, unknown sort fields, and — under the grammar — unknown filter fields, undeclared operators and bad literals fail decoding, which the schema-error middleware turns into a spec-compliant **400 JSON:API error document** whose error objects carry `source.parameter` naming the offending key (`filter[age][gt]`, `page[limit]`) — and, where the schema publishes what it would have accepted, the legal vocabulary as `meta`: a rejected `include` path carries `meta.includablePaths` (the endpoint's whole supported set, as `ApiError.UnsupportedIncludePath` does) and an unknown `sort` field `meta.sortableFields`, so a caller that guessed wrong needs no second request. HttpApi decodes a request with `errors: "first"`, so a query yields one error object — except the `filter` family, whose codec reports every offending key together.

Every comma-separated family also accepts the repeated-key spelling `UrlParams.toRecord` produces for a repeated key — `?sort=-createdAt&sort=title` decodes the same as `?sort=-createdAt,title`, and likewise for `include` and `fields[TYPE]` — in any mix of the two, and `filter[*]` accepts a repeated key at its list-valued positions ([the filter grammar](./docs/filter-grammar.md) §2). Encoding always emits the single comma form.

A parameter the endpoint's query does not declare never reaches the handler: decoding drops it, on an endpoint whose query declares no family at all (its decoded `query` is then `{}`) as on any other, and no spelling of one — a bare name next to its bracketed members, empty brackets, deeper nesting — can make the query fail to decode ([#260](https://github.com/thomasfosterau/effect-jsonapi/issues/260)).

The specification's own families are the exception: on an endpoint that does not support one — whose `query` doesn't declare it, as `Endpoint.get(R)` without `include`, any endpoint without `sort`, or any `Endpoint.get` for `page[…]` and `filter[…]` — the parameter, whatever its value (an empty `?include=` too), is a 400 naming it in `source.parameter` rather than being dropped ([#261](https://github.com/thomasfosterau/effect-jsonapi/issues/261)). JSON:API 1.1 requires it: §Inclusion of Related Resources for `include`; §Sorting for `sort` on an endpoint that responds with a resource collection; and for every other case, `sort` on a single-resource endpoint such as `GET /articles/1?sort=title` included, the general §Implementation-Specific Query Parameters rule, since the endpoint does not know how to process the parameter. The `SchemaErrors` middleware answers it before the endpoint decodes anything, so it also wins over a 406 or 415 the same request would get. An endpoint that declares the family with an empty vocabulary (`include: { paths: [] }`, `include: true` over a resource with no relationships, `sort: true` over one with no attributes, `filter: true` over one with no filterable field, `page: {}`, `filter: {}`) supports no value of it, so it gets the same 400, an empty value included ([#282](https://github.com/thomasfosterau/effect-jsonapi/issues/282)).

`fields` is per resource type. A `fields[TYPE]` is supported only for a type the endpoint declares a sparse fieldset for and whose resource has at least one attribute. `fields: true` declares every type the response can carry and no other: the resource; its non-`paginated` direct relationship targets, which a server MAY include by default, unless `include` is a declared `Include.Surface`; and, when `include` is on, every type a legal include path reaches (`include: true`'s `comments.author` declares `fields[people]`). So with `include` off it is the resource and its non-`paginated` direct targets; under `include: true`, `{ depth }` or `{ paths }`, those plus every type on the way down each legal path; under a surface, exactly the resource and the types its paths reach (its `included` union). Where one of those is a `Resource.family`, its member types are declared in its place (a member that is itself a family by its own members, in turn), since those are the types its resource objects carry: a relationship targeting a family over `editors` and `reviewers` declares `fields[editors]` and `fields[reviewers]`, and `fields[<family name>]` is not declared, so it is a 400 like any other undeclared type ([#350](https://github.com/thomasfosterau/effect-jsonapi/issues/350)). A type reachable only through a `paginated` relationship is never in `included`, so it is never declared. Any other `fields[TYPE]` (a type outside that set, or one with no attribute), a bare `fields` and a `fields[TYPE][…]` are each a 400 naming that parameter, while the endpoint's other `fields[TYPE]` keep decoding. Ignoring such a fieldset would answer with the fields the client excluded, which §Sparse Fieldsets forbids: "If a client requests a restricted set of [fields] for a given resource type, an endpoint **MUST NOT** include additional [fields] in resource objects of that type in its response."

`page` and `filter` are per member too ([#321](https://github.com/thomasfosterau/effect-jsonapi/issues/321)). On an endpoint that declares page keys (`Page.Offset`'s `page[offset]` / `page[limit]`, `Page.Number`, `Page.Cursor`, custom keys, a `Query.bracketPageKeys` struct) or an explicit filter map (`filter: { status: … }`), a member it does not declare — `?filter[stauts]=open` beside `filter[status]`, `?page[sise]=10` or `?page[size]=10` beside `Page.Offset`, a deeper `filter[status][eq]`, a bare `filter` or `page` — is a 400 under the spec's general rule (§Query Parameters: a server that does not know how to process a parameter from the specification **MUST** answer `400 Bad Request`), with `source.parameter` naming it as the request spelt it and a `detail` listing the members the endpoint does declare. Dropping it would hand the client an unfiltered or unpaginated collection it took for the one it asked for. A member counts by its wire name, so `Schema.encodeKeys({ state: "filter[status]" })` declares `filter[status]`. `filter: true` is unchanged: the open grammar declares the bare `filter` and every `filter[…]`, and rejects a malformed member itself; a hand-built open record of a family (`Schema.Record(Schema.TemplateLiteral(["filter[", Schema.String, "]"]), …)`) likewise admits every member it opens. `Middleware.checkQueryParameters` applies the same rule to its `declared` list.

`include` and `sort` have no members at all: JSON:API defines only the bare parameters. So a bracketed one — `?include[]=author`, `?include[x]=author`, `?sort[title]=1`, `?sort[x][y]=1` — is a 400 naming it under the spec's general rule, on an endpoint that declares the bare `include` / `sort` as on one that doesn't ([#329](https://github.com/thomasfosterau/effect-jsonapi/issues/329)); the query schema would otherwise drop it and the handler would see `{}`. Declared means supported: a hand-built `query` schema with a `"sort[x]"` property of its own supports that very name, and no other `sort[…]`. `Middleware.checkQueryParameters` treats a declared `include` or `sort` the same way.

### Declaring filterable and sortable attributes

Filterability is a per-resource property, declared per attribute: which attributes, which operators, and (from the attribute's own schema) what literal type. The declaration lives on the attribute schema itself: pipe it through `Filter.able` / `Sort.able` — Effect-native combinators in the manner of `Schema.brand` — and it rides with the schema as an annotation (`Filter.AnnotationId` / `Sort.AnnotationId`), the single source of truth `Resource.filterable` / `Resource.sortable` read back. An attribute declared with neither — or a plain `Schema` attribute — is not filterable and not sortable, so the declaration fails closed the way `include` / `fields` / `sort` already do.

```ts
import { Filter, Relationship, Resource, Sort } from "@thomasfosterau/effect-jsonapi";

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
    rating: Schema.NullOr(Schema.Number.pipe(Filter.able(["gte", "isnull"]))),
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

`Resource.sortable(R)` returns the declared attribute keys (attributes only), typed as their literal union, so it is the natural `sort` allow-list for an endpoint; `sort: true` keeps meaning "every attribute":

```ts
Endpoint.list(Product, { sort: Resource.sortable(Product), page: Query.Page.Offset });
// ?sort=-createdAt,priceCents decodes; ?sort=name is a 400
```

`filter: true` on a list endpoint turns on the `filter` query codec over this declaration — the grammar in [`docs/filter-grammar.md`](./docs/filter-grammar.md). `filter[f]=v` is `eq`, `filter[f]=a,b` is `in`, `filter[f][gt]=v` any operator, and a Drupal-style group form (`filter[g][group][conjunction]=OR`, `filter[c][condition][path]=…`) spells `OR`, `NOT`, nesting and repeated `(field, operator)` pairs. Handlers receive one decoded, normalised `Filter.Ast` root node, with `field` narrowed to the declared names and every literal decoded through its attribute schema:

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

The profile defines what a tree **means**, not only how it is spelled: [§6 of the grammar](./docs/filter-grammar.md#6-semantics) is the normative semantics — three-valued (Kleene) logic, a truth table per operator including every NULL case, the comparison domain of each attribute type, and the line between a 400 and an empty result. Handlers are what evaluate a tree, so that section is the contract they answer to; this package builds, validates and canonicalises trees and evaluates none.

### The canonical query string

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

The order is `include`; `fields[*]` sorted by type; `filter[*]` in [the grammar's canonical order](./docs/filter-grammar.md#33-key-order-and-ids) (shorthand sorted by key, the group form in the encoder's pre-order); `sort`; `page[*]` in the page strategy's declared order (`offset, limit` — what the link builders emit); then any other key, sorted. Keys and values go through `encodeURIComponent` (spaces `%20`, commas `%2C` — a list's separator and the grammar's `\,` alike), with `[` / `]` left readable in keys; `URLSearchParams` / `UrlParams` decode the result back identically. `Query.canonicalPairs(schema)` is the ordered pair list before serialisation and `Query.serialise(pairs)` the encoding on its own.

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

### Constraining the advertised include paths

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

A top-level constraint applies to `get` and `list`. The relationship endpoints' paths are their _target's_ graph, not this resource's, so they inherit only that `include` is on — constrain them with `Endpoint.related` directly if they need it too.

### Declaring the include surface once

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

Because the derivation recurses over the **declaration** rather than the relationship graph, a declared surface is not bound by the depth-2 ceiling `include: true` inherits: depth becomes a property of what you wrote. It is capped explicitly at `Include.MAX_DEPTH` (6) hops — the type-level derivation truncates past it and `Include.make` throws, so a too-deep declaration fails loudly at startup instead of silently advertising less than it declares.

A resource that declares no surface advertises no parameter, and `include: true` / `Query.IncludeOptions` behave exactly as before.

`Page.Offset` / `Page.Number` / `Page.Cursor` are the ready-made constants. For a **bounded, defaulted, dual-use** variant, call `Query.Page.offset(options)` (and, for page-number pagination, `Query.Page.number(options)`): it returns the same `{ offset, limit }` field-map but lets you cap `limit` with `maxLimit` (a DoS guard every JSON:API server wants), fill in `defaultLimit` / `defaultOffset` on decode, and — with `fromString: false` — build the fields from plain `Schema.Number` instead of `FiniteFromString`, so the one schema works both as a numeric call-site input and behind a transport that coerces query strings to numbers (e.g. raw `HttpApiEndpoint` wrapped in `Schema.toCodecStringTree`).

```ts
// caps page size at 100, defaults to 25, still decodes from query strings
Endpoint.list(Article, { page: Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }) });
```

### Bracketing page keys on a query struct you own

`Query.schema`'s `page` option composes the whole query and **nests** the decoded cursor under a `page` key. Some applications instead merge pagination **flat** into their own list-input struct — `{ limit, offset, …filters }` — because the rest of the application consumes that flat type directly and shouldn't learn a transport-shaped nesting.

`Query.bracketPageKeys` is the standalone rename for exactly that case: given any struct carrying `offset` and `limit`, it re-keys **only those two encoded keys** to `page[offset]` / `page[limit]`, leaving the decoded type and every other field's wire key alone. The bracket family it produces is the same one `Handlers.offsetPaginationLinks` emits, so following a `next` link decodes straight back into the flat `{ offset, limit }` the list operation reads. A rejected value is reported under the name the request sent: `?page[limit]=abc` is a 400 with `source.parameter: "page[limit]"`, not the decoded `limit`, and the same holds for any property `Schema.encodeKeys` renames. Bodies, headers and path parameters follow the same rule ([#316](https://github.com/thomasfosterau/effect-jsonapi/issues/316)): a renamed body member is named by its wire name in `source.pointer`, at any depth (`/data/itemCount` for a `count` sent as `itemCount`), a renamed header in `source.header` (`x-trace`) and a renamed path parameter in `source.parameter` (`itemId`).

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

## Spec compliance, by construction

| JSON:API v1.1 rule | How it's enforced |
| --- | --- |
| Media type `application/vnd.api+json` | baked into every document/payload/error schema |
| 415/406 on media type parameters other than `ext` / `profile` (or unsupported extensions) | middleware attached to every endpoint; providing it is required by the type system |
| Error bodies are error documents | only `ApiError.make` classes can be declared as endpoint errors |
| Top-level document holds exactly one of `data` / `errors` / `meta` | success schemas only ever contain `data`; error schemas only `errors` — mixing is unrepresentable |
| `null` primary `data` only for a single-resource URL that might correspond to a resource but currently doesn't | `DataDocument` is a pure envelope: `DataDocument(R)` is non-null; opt into `data: null` with `Schema.NullOr(R)` / `R.nullable()`. `Endpoint.related` keeps the nullable form for a to-one relationship |
| Resource objects have `type` and `id`; ids are not interchangeable across types | `Resource` always emits the type tag and a per-type branded id |
| Create requests may omit `id` and send `lid` | `createPayload` derivation |
| Update requests require `id`, attributes are partial | `updatePayload` derivation |
| Relationships hold at least one of `data` / `links` / `meta` | `one` / `optional` / `many` schemas require resource linkage (`data`); `paginated` schemas require `links.related` |
| Relationship endpoints: GET/PATCH on to-one, GET/POST/PATCH/DELETE on to-many | `Endpoint.getRelationship` / `updateRelationship` / `addRelationship` / `removeRelationship`; add/remove only constructible for to-many relationships |
| Related resource endpoints (`related` links) | `Endpoint.related` — single-resource document with nullable `data` for to-one (empty-linkage case), paginated collection for to-many |
| Compound documents: no duplicate resources, full linkage | `Handlers.resolveIncluded` walks the requested paths into one `(type, id)`-keyed bucket, so its output is fully linked by construction; `Handlers.data` / `Handlers.collection` deduplicate against the primary data and check full linkage on the resources they emit, after `onResource` (runtime check — it catches an `included` member a transform has left unreachable, [so keep it on](#resolving-included--one-batch-per-level)). The check walks reachability from the primary data, as [the conformance kit](#proving-it-the-conformance-kit)'s `spec/document/full-linkage` does, so a document the builders accept passes that rule on the document value they build: a cycle of members the primary data does not reach, or a member referenced only by itself, throws. Encoding drops relationship keys the resource does not declare, so a member reached only through an undeclared relationship passes the builders but not the rule on the wire ([#250](https://github.com/thomasfosterau/effect-jsonapi/issues/250)) |
| Compound documents never inline unbounded relationships | `paginated` relationships are excluded from `?include=` paths and `included` unions by construction |
| `errors` array is never empty | non-empty check on the error document schema |
| 200 / 201 / 204 status codes per operation | set by the endpoint constructors |
| A 201 create carries `Location`, matching the created resource's `links.self` | `Endpoint.create` attaches `Middleware.CreatedLocation`, which copies the resource's (or the document's) `self` link into the header |
| Pagination / sorting / sparse fieldsets / inclusion / filtering query families | typed query schemas derived from the resource definition |
| Atomic operations extension: `atomic:operations` / `atomic:results` documents, lid refs, relationship operations | `Endpoint.operations` + `Atomic` schemas derived from resource definitions |
| Profiles are negotiated, advertised in `jsonapi.profile`, and unknown ones ignored | the filter grammar and idempotency profiles publish URIs; negotiation ignores profiles it doesn't know |

## Proving it: the conformance kit

The table above is what the constructors guarantee. It says nothing about your server once a handler has an opinion — so `Conformance` is an **executable specification** you run against your own `HttpApi`, which fails naming the broken rule and citing its section rather than printing an assertion diff.

```ts
import { Effect } from "effect";
import { Conformance } from "@thomasfosterau/effect-jsonapi";
import { Api } from "./api.js";
import { BlogLive } from "./handlers.js";

const report = await Effect.runPromise(
  Conformance.verify(Api, {
    // the fixture contract: one known-existing id per resource type
    ids: { articles: "1", people: "9" },
  }).pipe(Effect.provide(BlogLive), Effect.scoped),
);

console.log(Conformance.format(report));
```

Endpoints are discovered from the `HttpApi` value — method, path, declared query families, response media type — but every rule is decided by a real request/response pair, because conformance is a wire property and the typed client both hides the raw status, media type parameters and unparsed body, and refuses to construct the malformed requests half the rules need to send. `verify` drives an in-memory transport over the real router (no port bound, no fixture beyond the ids); `Conformance.verifyWith(api, { client, baseUrl })` runs the **identical** rules against a deployed server over `FetchHttpClient`.

Failures read as a report, not a diff:

```
FAIL  spec/content-negotiation/accept-weight-is-not-a-parameter
      MUST NOT · Content Negotiation (with RFC 9110 §12.4.2)
      A `q` weight is an Accept-header parameter, not a media type parameter (RFC 9110 §12.4.2),
      so a JSON:API media type instance carrying only a non-zero `q` MUST NOT be counted as
      parameterised and MUST NOT be rejected with 406.
      https://jsonapi.org/format/1.1/#content-negotiation-servers
      · a weighted preference between HTML and JSON:API was treated as a disallowed media type parameter
        GET /articles/1  [accept: text/html;q=0.9, application/vnd.api+json;q=0.8]
        expected: any status but 406 — the weight is not a media type parameter
        observed: 406 application/vnd.api+json — {"errors":[{"status":"406", …
```

**Writes need a fixture, and are opt-in.** The kit cannot invent a payload your server will accept, so the create / update / delete rules (201 with the created resource, `Location`, the update and delete responses, the atomic extension's response media type) run only with `mutating: true` and a write fixture per type:

```ts
let n = 0;
Conformance.verify(Api, {
  ids: { articles: "1" },
  mutating: true,
  writes: {
    articles: {
      create: () => ({
        type: "articles",
        attributes: { title: `conformance probe ${++n}`, body: "…" },
        relationships: { author: { data: { type: "people", id: "9" } } },
      }),
      update: () => ({ attributes: { title: `conformance probe ${++n} (updated)` } }),
      cleanup: (id) => deleteArticleFromYourStore(id), // an Effect
    },
  },
});
```

Each write rule creates its own target from `create`, and acts on the id the server's create response named only after checking it: the response must name a resource of the type `create` returned, under an id that is a URL path segment of its own (not `""`, `.`, `..` or a lone surrogate) and is neither an `ids` sample, nor one a read earlier in the run returned (unless the kit had already taken it from a create of its own), nor one the run already holds — anything else is recorded as named and never updated, deleted or passed to `cleanup`. That check refuses only ids that are evidently not what the kit created: a server that answers a create with the id of some other existing resource cannot be told from an honest one, so run `writes` only against a server and data you can afford to have modified. `cleanup` runs after the rule that made it whether that rule passed, failed or died; and `report.writes` (printed under `WRITES`) lists everything the run created and what became of it. A type with no fixture skips its write rules naming the missing key. `cleanup` may be omitted for a target you throw away (an in-process store) — the report then lists what was left — but supply it against anything that outlives the run.

Two tiers, separately runnable. `spec` is JSON:API v1.1 alone; `profile` is this package's filter grammar profile, the Idempotency-Key profile's advertisement (with the write fixture, a create on an endpoint declaring `Idempotency-Key` must name the profile in `jsonapi.profile` — answer with `jsonapi: Idempotency.jsonapi` — or on its media type) and the conventions it adds where the spec declines to have one. Pass `tiers: ["spec"]` to hold a server to the specification without adopting any of this library's opinions.

**It says what it did not check.** Every rule that could not run reports why — no endpoint of that shape, no sample id, no write fixture, a mutating probe not opted into — and `Conformance.gaps` declares the areas the kit does not cover at all (filter _evaluation_ semantics, sort-ordering correctness, the write rules beyond the success responses, atomic processing, retried writes under the Idempotency-Key profile), each with its reason and tracking issue. Both are printed in every report, and skips are counted separately from passes, so a run that proved little cannot read as a clean bill of health.

**A rule that dies does not cost you the report.** A defect in one rule — a transport that throws, or a bug in the kit — becomes that rule's `Errored` outcome (printed as `DIED`, with the defect's message, and counted as `errored` by `Conformance.summarise`); every other rule still runs and is reported, and so is `report.writes`. Interruption is not caught: it still stops the run, after the cleanup of whatever the interrupted rule created. A write fixture member that throws is not a defect, whatever it throws: a `create` or `update` that throws skips the rules it would have driven, and a `cleanup` that fails or throws is recorded in `report.writes`.

Use `Conformance.assert(report)` as a gate: it fails with a `ContractViolation` carrying the rule, its requirement, its citation and the request that decided it. A rule that died is not a finding about your server, but the run could not decide it either, so `assert` dies on it — with a defect tagged `RuleDied` naming the rule and the defect, the original as its `cause` — rather than passing. If you gate on `summarise(report).failed` or `findings(report)` instead of `assert`, also check `summarise(report).errored === 0`.

**Against a live server, bound the run.** `verifyWith` runs the identical rules over any `HttpClient` and `baseUrl`. Two options bound what that costs the server:

- `skip` — rule-id prefixes to leave out, the complement of `only` and matched the same way: `skip: ["spec/pagination/links-enumerate-collection", "spec/links/"]` leaves out the pagination walk and the link crawl, the rules that make the most requests. It removes rules from what `tiers` and `only` select, and a rule it leaves out is absent from the report, as one `only` does not select is.
- `requestTimeout` — a `Duration.Input` (`"10 seconds"`) bounding each request, its body included; each redirect hop gets its own. A request still unanswered then is aborted and reads as a lost response naming the timeout, which every rule treats as any transport error. Thirty seconds by default, for `verify` and `verifyWith` alike; `requestTimeout: "Infinity"` (or `Duration.infinity`) turns it off, so the kit waits as long as the transport does. A duration that is not positive, or one `Duration` cannot read (e.g. `"1e3 seconds"`), is a defect.

Full design note, including the coverage ledger and what it would take to close each gap: [`docs/conformance.md`](./docs/conformance.md).

## Examples

Complete runnable examples (resources, errors, api, in-memory handlers) live in [`examples`](./examples). Each is a **standalone package** in the pnpm workspace — it depends on `@thomasfosterau/effect-jsonapi` and carries its own tests, so you can lift any one out as a starting point. Run them all from the repo root with `vp run -r test:unit`, or a single one with `vp run --filter ./examples/northwind test:unit`.

| Example | What it shows | Test |
| --- | --- | --- |
| [`examples/blog`](./examples/blog) | The classic JSON:API blog: articles, people, tags, comments; full CRUD; a required (`one`) author, inlined (`many`) tags and a paginated comment feed with attach/detach relationship endpoints; heterogeneous search; an atomic operations endpoint with all-or-nothing semantics and lid resolution | [`blog/test`](./examples/blog/test) |
| [`examples/github`](./examples/github) | A GitHub-like API: users, repositories, issues, issue comments, pull requests, labels; all four relationship kinds (required `owner`/`author`, nullable `assignee`, inlined `labels`, paginated `comments`); issue triage via relationship endpoints (assign/unassign, add/remove/replace labels); 2-hop include paths (`repository.owner`); per-group endpoint subsets; typed filters over closed attribute sets; page-number pagination; 403/404/422 domain errors; global search across three resource types | [`github/test`](./examples/github/test) |
| [`examples/northwind`](./examples/northwind) | A Northwind Traders e-commerce API: categories, suppliers, shippers, customers, territories, employees, products, orders and line items; all four relationship kinds laid out as an acyclic graph (required `category`/`supplier`/`customer`/`employee`, nullable `shipper`, inlined `territories`, a paginated line-item feed); the reverse directions (a category's products, a customer's orders) and the self-referential reporting hierarchy modelled as `filter[…]` collection endpoints; product CRUD with typed numeric price-range filters; offset/limit pagination; territory assignment and order shipping via relationship endpoints; 404/409 domain errors; global catalog search across three resource types | [`northwind/test`](./examples/northwind/test) |

## Metadata

`meta` is free-form by spec, so every `meta` member accepts arbitrary records by default. Tighten any of them by passing a schema:

```ts
// Resource-level meta (on every resource object)
const Article = Resource.make("articles", {
  attributes: { … },
  meta: Schema.Struct({ rank: Schema.Int })
})

// Document-level meta (per endpoint, e.g. pagination totals)
Endpoint.list(Article, { meta: Schema.Struct({ total: Schema.Int }) })

// Or on a document schema directly
Article.collection({ meta: Schema.Struct({ total: Schema.Int }) })
```

Relationship and resource-identifier `meta` currently accept free-form records (untyped).

## Limitations

- **Conformance coverage is partial, and says so**: the kit covers content negotiation, document structure, error objects, query-parameter handling, pagination links (following `next` must enumerate the collection), resource `self` and relationship `related` links (each followed must answer resource data, a `self` the resource it names, and a `related` should answer the resources its linkage names) and the filter grammar profile. Filter _evaluation_ semantics, sort-ordering correctness, the write rules beyond the success responses (conflicts, client-generated ids, relationship mutation), atomic processing and relationship / top-level `self` links are declared gaps rather than silent omissions — see `Conformance.gaps` and [`docs/conformance.md`](./docs/conformance.md).
- **Sparse fieldsets are opt-in, not automatic**: `?fields[TYPE]=` is decoded, validated and handed to your handler, and the builders project it when you ask them to — `Handlers.data(article, { included, onResource: Handlers.project(query.fields) })` ([the per-resource transform pass](#the-per-resource-transform-pass-onresource)). Nothing is projected behind your back; the builders don't post-process responses against request state on their own. The default document of an endpoint declaring `fields` admits the projected answer, so its clients read those attributes as optional ([sparse fieldsets and the default document](#sparse-fieldsets-and-the-default-document)). Relationship fields (`?fields[articles]=author`) are out of scope: `Query.Fieldset` is built from the resource's attributes, so a relationship name cannot be requested.
- **Graph-derived include paths are typed to a depth of 2 hops** (`"comments.author"` works, `"comments.author.employer"` doesn't) — a TypeScript recursion-depth trade-off; `{ depth: 3 }` raises it one hop, and the runtime validation matches the same set. Declaring the surface explicitly with `Include.make` lifts the ceiling altogether (up to `Include.MAX_DEPTH`), because the derivation then recurses over the declaration rather than the graph.
- **Server-side `included` narrowing is not possible**: a handler's return type cannot depend on the runtime value of `?include=` (that's dependent typing). Client-side narrowing is provided via `Client.narrowIncluded`.
- **Relationship and identifier `meta` are untyped** (free-form records); resource and document meta are typed via options.
- **Mutually recursive resources** (A ↔ B) need one interface annotation per resource in the cycle — `Resource.make`'s return type is inferred, and two inferred types cannot reference each other. See [Mutually recursive resources](#mutually-recursive-resources) for the pattern; everything derived from the definitions is unaffected.
- **`narrowIncluded` over a heterogeneous response narrows by the whole union, not per primary resource**: pass the union of the response's resource definitions (a family's members, say) and each path resolves against every member that declares it, never crossing a member's `paginated` relationship. `included` is document-wide, so it narrows to everything any member reaches; which primary resource reached a given entry is not tracked.
- **Atomic operations requests are accepted with or without the `ext` media type parameter**: spec-compliant clients send `application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"` (accepted once the middleware declares the extension), but the bare media type is not rejected. Responses always carry the parameter.

## License

MIT © Thomas Foster
