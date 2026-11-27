# effect-jsonapi guides

| Guide | Covers |
| --- | --- |
| [Resources](resources.md) | `Resource.make`, relationships, payloads, families, metadata |
| [Errors and endpoints](endpoints.md) | `ApiError`, `Endpoint`, `Group`, relationship endpoints, atomic operations, idempotency |
| [Handlers](handlers.md) | Document builders, serving a group from a `ResourceService`, `included` resolution, middleware, sparse fieldsets |
| [Query parameters](query.md) | `include`, `fields`, `sort`, `page`, `filter`, the canonical query string |
| [The client](client.md) | `Client.make`, include narrowing, error documents, hydration, page cursors |
| [The server skeleton](server.md) | Flat contracts, the error seam, negotiation, the assembler and registry |
| [Conformance kit](conformance.md) | Running `Conformance` against a server |

## Overview

`@thomasfosterau/effect-jsonapi` makes it **trivial to comply with the JSON:API spec, invariantly** — compliance is a property of the construction, not of developer discipline:

- Define each **resource once**; identifiers, create/update payloads, documents, query parameters and endpoints are all derived from that single definition.
- Declare each **error once**; you get a tagged Effect error whose wire encoding _is_ a spec-compliant JSON:API error document with the right HTTP status.
- **Endpoints** bake in the conventions: the `application/vnd.api+json` media type, conventional paths, spec status codes (200/201/204), typed `include` / `fields[TYPE]` / `sort` / `page[*]` / `filter[*]` query parameters, and content-negotiation rules (406/415).
- The spec rules the constructors enforce are executable: [`test/compliance.test.ts`](../test/compliance.test.ts) drives each one on the wire, and [`test/compliance.types.ts`](../test/compliance.types.ts) pins those enforced at compile time.
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

Each subpath ships its module's own declaration file, which is what lets declaration emit name a type the inferred type of an exported value mentions — see [Declaration emit](#declaration-emit). The root import stays the default; nothing needs to move.

### Declaration emit

A project that compiles with `declaration: true` can export what it builds — an endpoint, a group, an `HttpApi`, a client — with no annotation, wherever the resources it is built over are defined:

```ts
// endpoints.ts
import { Endpoint } from "@thomasfosterau/effect-jsonapi";
import { Person } from "./resources.js";

export const getPerson = Endpoint.get(Person);
```

Declaration emit writes the value's inferred type into the `.d.ts`, so it must be able to name every type that type mentions, such as `Resource.Resource` and `Resource.Id` here. The TypeScript checker names a type only through a namespace the file imports itself or through a module that exports the type directly, never through a namespace alias like the root's `Resource`, and the module subpaths are those modules: it writes `import("@thomasfosterau/effect-jsonapi/Resource").Resource<"people", …>`.

The type-only aliases at the package root (`QuerySchema`, `ContentNegotiation`, `ApiErrorWire`, `BadRequest`, …) served the same purpose for the single-file case. Declaration emit no longer needs them, and they are **deprecated** in favour of the subpaths: write `Query.QuerySchema`, or import it from `@thomasfosterau/effect-jsonapi/Query`. They remain exported for now. The checker still prefers a direct root export when it names a type, so your own emitted `.d.ts` may reference them (`import("@thomasfosterau/effect-jsonapi").ContentNegotiation`), which is why removing them later will be a breaking change for downstream published declarations.

## Limitations

- **Conformance coverage is partial, and says so**: the kit's rules and its declared gaps (`Conformance.gaps`) are listed in [the conformance guide](conformance.md).
- **Sparse fieldsets are applied on the way out**: `?fields[TYPE]=` is decoded, validated and handed to your handler, and `Middleware.layer` projects the encoded 2xx document to it, primary data and `included` alike, so a handler that returns whole resources still answers to §Sparse Fieldsets. A handler can project first with `Handlers.data(article, { included, onResource: Handlers.project(query.fields) })` ([the per-resource transform pass](handlers.md#the-per-resource-transform-pass-onresource)), which skips the work the middleware would redo; `sparseFieldsets: "verify"` on `JsonApiConfig.layer` or `Middleware.layerWith` checks instead of projecting (a violation is a 500), and `"handler"` turns it off. The default document of an endpoint declaring `fields` admits the projected answer, so its clients read those attributes as optional ([sparse fieldsets and the default document](handlers.md#sparse-fieldsets-and-the-default-document)). A fieldset names relationships as well as attributes (`?fields[articles]=title,author`), and the projection drops the relationships it does not name, the spec's sparse-fieldset exemption from full linkage covering the `included` members they linked.
- **Graph-derived include paths are typed to a depth of 2 hops** (`"comments.author"` works, `"comments.author.employer"` doesn't) — a TypeScript recursion-depth trade-off; `{ depth: 3 }` raises it one hop, and the runtime validation matches the same set. Declaring the surface explicitly with `Include.make` lifts the ceiling altogether (up to `Include.MAX_DEPTH`), because the derivation then recurses over the declaration rather than the graph.
- **Server-side `included` narrowing is not possible**: a handler's return type cannot depend on the runtime value of `?include=` (that's dependent typing). Client-side narrowing is provided via `Client.narrowIncluded`.
- **Relationship and identifier `meta` are untyped** (free-form records); resource and document meta are typed via options.
- **Mutually recursive resources** (A ↔ B) need one interface annotation per resource in the cycle — `Resource.make`'s return type is inferred, and two inferred types cannot reference each other. See [Mutually recursive resources](resources.md#mutually-recursive-resources) for the pattern; everything derived from the definitions is unaffected.
- **`narrowIncluded` over a heterogeneous response narrows by the whole union, not per primary resource**: pass the union of the response's resource definitions (a family's members, say) and each path resolves against every member that declares it, never crossing a member's `paginated` relationship. `included` is document-wide, so it narrows to everything any member reaches; which primary resource reached a given entry is not tracked.
- **Atomic operations requests are accepted with or without the `ext` media type parameter**: spec-compliant clients send `application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"` (accepted once the middleware declares the extension), but the bare media type is not rejected. Responses always carry the parameter.

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
