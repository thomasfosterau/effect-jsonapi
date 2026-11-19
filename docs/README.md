# effect-jsonapi guides

| Guide | Covers |
| --- | --- |
| [Resources](resources.md) | `Resource.make`, relationships, payloads, families, metadata |
| [Errors and endpoints](endpoints.md) | `ApiError`, `Endpoint`, `Group`, relationship endpoints, atomic operations, idempotency |
| [Handlers](handlers.md) | Document builders, `included` resolution, middleware, sparse fieldsets |
| [Query parameters](query.md) | `include`, `fields`, `sort`, `page`, `filter`, the canonical query string |
| [The client](client.md) | `Client.make`, include narrowing, error documents, hydration, page cursors |
| [The server skeleton](server.md) | Flat contracts, the error seam, negotiation, the assembler and registry |
| [Spec compliance](compliance.md) | What the constructors guarantee, declaration emit, limitations |
| [Conformance kit](conformance.md) | Running `Conformance` against a server |
| [Filter grammar](filter-grammar.md) | The `filter` / `sort` profile, normative |
| [Idempotency profile](idempotency.md) | The `Idempotency-Key` profile, normative |
| [Adopting 0.14](guides/adopting-0.14.md) | Replacing hand-rolled application code with the package's surfaces |

## Overview

`@thomasfosterau/effect-jsonapi` makes it **trivial to comply with the JSON:API spec, invariantly** — compliance is a property of the construction, not of developer discipline:

- Define each **resource once**; identifiers, create/update payloads, documents, query parameters and endpoints are all derived from that single definition.
- Declare each **error once**; you get a tagged Effect error whose wire encoding _is_ a spec-compliant JSON:API error document with the right HTTP status.
- **Endpoints** bake in the conventions: the `application/vnd.api+json` media type, conventional paths, spec status codes (200/201/204), typed `include` / `fields[TYPE]` / `sort` / `page[*]` / `filter[*]` query parameters, and content-negotiation rules (406/415).
- Everything is a plain Effect `Schema` / `HttpApiEndpoint` / `HttpApiGroup`, so it composes with `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi` untouched.

## Quick start

A complete read API — resource, error, endpoints, handlers, server — in one file. Each piece is expanded in the guides.

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

## The schema-only entry point

The package root exports everything and is the import you want by default. It reaches `effect/http-api`, because the error classes, endpoints, groups, media type combinators and middleware are built on Effect's `HttpApi`.

Consumers that only want JSON:API's **wire types without the server** — a client decoding documents, a loader mapping them into something else, a CLI or code generator producing them — can import the same modules from a schema-only subpath that never reaches Effect's HTTP surface. Its dependencies are `effect`'s core and effect-ext's Schema subpaths, which import only `effect`'s core:

```ts
import { Document, Resource } from "@thomasfosterau/effect-jsonapi/schema";
```

`/schema` re-exports `Document`, `Filter`, `FlatQuery`, `Include`, `Relationship`, `Resource`, `Sort` and `MEDIA_TYPE` — the modules whose import graph reaches only `effect`'s core and those effect-ext subpaths. Every symbol is the same object under both imports. Which modules are in the tier, and why `Query` (whose `Query.validateIncludePaths` fails with `HttpApi`-bound error classes) and `Client` are not: see the `/schema` module doc.

## Module subpaths

Every module is also published as a subpath of its own, as `effect` publishes `effect/Schema`: `@thomasfosterau/effect-jsonapi/Resource`, `…/Endpoint`, `…/Group`, and so on for each namespace the root exports. A subpath is the same module as the root's namespace, not a copy, so `Resource.make` and the error classes are identical whichever way they are imported, and the schema-tier modules (`Document`, `Filter`, `FlatQuery`, `Include`, `Relationship`, `Resource`, `Sort`) keep the same dependencies under their subpaths too: `effect`'s core and effect-ext's Schema subpaths.

```ts
import * as Endpoint from "@thomasfosterau/effect-jsonapi/Endpoint";
import * as Resource from "@thomasfosterau/effect-jsonapi/Resource";
```

Each subpath ships its module's own declaration file, which is what lets declaration emit name a type the inferred type of an exported value mentions — see [Declaration emit](compliance.md#declaration-emit). The root import stays the default; nothing needs to move.

## API

Every module is a namespace export of the package root (`import { Resource } from "@thomasfosterau/effect-jsonapi"`); the guides walk through them in the order you would build a server.

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

## Examples

Complete runnable examples (resources, errors, api, in-memory handlers) live in [`examples`](../examples). Each is a **standalone package** in the pnpm workspace — it depends on `@thomasfosterau/effect-jsonapi` and carries its own tests, so you can lift any one out as a starting point. Run them all from the repo root with `vp run -r test:unit`, or a single one with `vp run --filter ./examples/northwind test:unit`.

| Example | What it shows | Test |
| --- | --- | --- |
| [`examples/blog`](../examples/blog) | The classic JSON:API blog: articles, people, tags, comments; full CRUD; a required (`one`) author, inlined (`many`) tags and a paginated comment feed with attach/detach relationship endpoints; heterogeneous search; an atomic operations endpoint with all-or-nothing semantics and lid resolution | [`blog/test`](../examples/blog/test) |
| [`examples/github`](../examples/github) | A GitHub-like API: users, repositories, issues, issue comments, pull requests, labels; all four relationship kinds (required `owner`/`author`, nullable `assignee`, inlined `labels`, paginated `comments`); issue triage via relationship endpoints (assign/unassign, add/remove/replace labels); 2-hop include paths (`repository.owner`); per-group endpoint subsets; typed filters over closed attribute sets; page-number pagination; 403/404/422 domain errors; global search across three resource types | [`github/test`](../examples/github/test) |
| [`examples/northwind`](../examples/northwind) | A Northwind Traders e-commerce API: categories, suppliers, shippers, customers, territories, employees, products, orders and line items; all four relationship kinds laid out as an acyclic graph (required `category`/`supplier`/`customer`/`employee`, nullable `shipper`, inlined `territories`, a paginated line-item feed); the reverse directions (a category's products, a customer's orders) and the self-referential reporting hierarchy modelled as `filter[…]` collection endpoints; product CRUD with typed numeric price-range filters; offset/limit pagination; territory assignment and order shipping via relationship endpoints; 404/409 domain errors; global catalog search across three resource types | [`northwind/test`](../examples/northwind/test) |
