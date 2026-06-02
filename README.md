# effect-jsonapi

Type-safe, spec-compliant [JSON:API v1.1](https://jsonapi.org/format/1.1/) on [Effect](https://effect.website)'s HttpApi.

[![npm version](https://badge.fury.io/js/effect-jsonapi.svg)](https://www.npmjs.com/package/effect-jsonapi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

`effect-jsonapi` makes it **trivial to comply with the JSON:API spec, invariantly** — compliance
is a property of the construction, not of developer discipline:

- Define each **resource once**; identifiers, create/update payloads, documents, query parameters
  and endpoints are all derived from that single definition.
- Declare each **error once**; you get a tagged Effect error whose wire encoding *is* a
  spec-compliant JSON:API error document with the right HTTP status.
- **Endpoints** bake in the conventions: the `application/vnd.api+json` media type, conventional
  paths, spec status codes (200/201/204), typed `include` / `fields[TYPE]` / `sort` / `page[*]` /
  `filter[*]` query parameters, and content-negotiation rules (406/415).
- Everything is a plain Effect `Schema` / `HttpApiEndpoint` / `HttpApiGroup`, so it composes with
  `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi` untouched.

```ts
import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { JsonApi } from "effect-jsonapi"
```

> **Status**: built against `effect@4.0.0-beta.70` (the v4 beta). The
> `effect/unstable/httpapi` surface may shift between betas.

## 1. Resources — the single source of truth

```ts
const Person = JsonApi.Resource("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString
  }
})

const Comment = JsonApi.Resource("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: {
    author: JsonApi.toOne(() => Person)      // a reference, not a string — typos don't compile
  }
})

const Article = JsonApi.Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    createdAt: Schema.DateFromString          // ISO string on the wire, Date in your code
  },
  relationships: {
    author: JsonApi.toOne(() => Person),
    comments: JsonApi.toMany(() => Comment)
  }
})
```

Everything below is **derived** — never assembled by hand:

| Derived                  | What it is                                                              |
| ------------------------ | ----------------------------------------------------------------------- |
| `Article`                | the resource object `Schema.Struct` itself (`type`/`id`/`attributes`/…) |
| `Article.Id`             | branded id schema — `Article.Id` values can't be mixed with `Person.Id` |
| `Article.identifier`     | the `{ type: "articles", id }` resource-identifier schema               |
| `Article.ref("1")`       | a typed identifier *value* — handy for relationship linkage             |
| `Article.createPayload`  | `{ data: { type, lid?, attributes, relationships? } }` — no `id`        |
| `Article.updatePayload`  | `{ data: { type, id, attributes? (partial), relationships? } }`         |
| `Article.document()`     | single-resource document; `included` union derived from relationships   |
| `Article.collection()`   | collection document (strict array `data`)                               |
| `typeof Article.Type`    | the decoded TypeScript type                                             |

Documents are not limited to one resource type — see
[Heterogeneous endpoints](#heterogeneous-endpoints-search-feeds) for polymorphic collections.

## 2. Errors — declared once, spec-compliant forever

```ts
class ArticleNotFound extends JsonApi.Error<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
  fields: { id: Schema.String },                  // typed fields, round-tripped through the wire
  detail: (e) => `Article ${e.id} not found`
}) {}
```

One declaration gives you all of:

- a **tagged error class**: `Effect.fail(new ArticleNotFound({ id }))`, `Effect.catchTag("ArticleNotFound", …)`
- a **wire schema** (`ArticleNotFound.wire`) whose encoded form is a JSON:API error document:

  ```json
  {
    "errors": [{
      "status": "404",
      "code": "not_found",
      "title": "Resource not found",
      "detail": "Article 42 not found",
      "meta": { "id": "42" }
    }]
  }
  ```

- the **HTTP status** and OpenAPI documentation for free.

`JsonApi.BadRequest` (400), `JsonApi.NotAcceptable` (406), `JsonApi.UnsupportedMediaType` (415),
`JsonApi.Forbidden` (403) and `JsonApi.Conflict` (409) are predefined.

## 3. Endpoints & groups — conventions baked in

```ts
const articles = JsonApi.Group(Article,
  // GET /articles/:id?include=author,comments.author&fields[articles]=title
  JsonApi.Endpoint.fetch(Article, {
    include: true,
    fields: true,
    errors: [ArticleNotFound]
  }),
  // GET /articles?sort=-createdAt&page[offset]=0&page[limit]=10&filter[author]=9
  JsonApi.Endpoint.list(Article, {
    include: true,
    sort: ["createdAt", "title"],
    page: JsonApi.Page.Offset,
    filter: { author: Schema.optionalKey(Schema.String) },
    meta: Schema.Struct({ total: Schema.Int })
  }),
  // POST /articles → 201 (client may send a lid)
  JsonApi.Endpoint.create(Article, { errors: [TitleTaken] }),
  // PATCH /articles/:id (partial attributes)
  JsonApi.Endpoint.update(Article, { errors: [ArticleNotFound] }),
  // DELETE /articles/:id → 204
  JsonApi.Endpoint.remove(Article, { errors: [ArticleNotFound] })
)

const Api = HttpApi.make("blog").add(articles)
```

### Heterogeneous endpoints (search, feeds)

`Endpoint.search` builds collection endpoints whose `data` mixes several resource types,
discriminated by their `type` tags — the natural fit for search results, feeds and timelines:

```ts
const search = JsonApi.Group("search",
  // GET /search?filter[q]=bikeshed&include=author&page[offset]=0&page[limit]=10
  JsonApi.Endpoint.search([Article, Person], {
    filter: { q: Schema.String },
    include: true,                            // include paths span both resources' graphs
    fields: true,                             // ?fields[articles]= and ?fields[people]=
    page: JsonApi.Page.Offset,
    meta: Schema.Struct({ total: Schema.Int })
  })
)

const Api = HttpApi.make("blog").add(articles).add(search)

// Handlers return mixed collections; clients discriminate on `type`:
for (const result of doc.data) {
  if (result.type === "articles") result.attributes.title        // Article
  else                            result.attributes.firstName    // Person
}
```

The `included` union spans every searched resource's relationship targets, and query features
(`fields[TYPE]`, `include`, `sort`) are derived across **all** of the resources in the union.

Every endpoint automatically:

- serves and accepts **`application/vnd.api+json`**
- declares its errors as **JSON:API error documents** at the right status
- carries the **content-negotiation middleware** (415 on parameterised request media types, 406 on
  unacceptable `Accept` headers) and the **schema-error middleware** (malformed
  params/query/payloads become JSON:API 400 documents) — and because they're real
  `HttpApiMiddleware` services, **the api won't build until you provide them**: forgetting is a
  compile error, not a runtime surprise
- documents itself in **OpenAPI** (`OpenApi.fromApi(Api)`) with the JSON:API media type, status
  codes and bracket query parameters

## 4. Handlers — typed in, validated out

```ts
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("fetch", ({ params, query }) =>
      //                 ^ params.id is a branded Article id
      //                         ^ query.include / query.fields are typed & validated
      loadArticle(params.id).pipe(
        Effect.map((article) =>
          JsonApi.data(article, {
            included: resolveIncluded(article, query.include),
            self: `/articles/${article.id}`
          })
        )
      ))
    .handle("list", ({ query }) =>
      // query.sort: [{ field: "createdAt", direction: "desc" }]
      // query.page: { offset?: number, limit?: number }
      listArticles(query).pipe(
        Effect.map(({ items, total }) =>
          JsonApi.collection(items, {
            meta: { total },
            links: JsonApi.offsetPaginationLinks("/articles", query.page ?? {}, total)
          })
        )
      ))
    .handle("create", ({ payload }) =>
      // payload.data.attributes is fully typed; payload.data.lid is supported
      createArticle(payload.data).pipe(Effect.map((article) => JsonApi.data(article))))
    .handle("update", ({ params, payload }) => /* … */)
    .handle("remove", ({ params }) => deleteArticle(params.id))   // void → 204
)
```

The document builders (`JsonApi.data` / `JsonApi.collection`) enforce the compound-document rules
at runtime: `included` is **deduplicated** by `(type, id)` and checked for **full linkage** (every
included resource must be referenced in the document).

To serve it (with `@effect/platform-node`):

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

HttpApiBuilder.layer(Api).pipe(
  Layer.provide(ArticlesLive),
  Layer.provide(JsonApi.Middleware.layer),    // content negotiation + JSON:API 400s
  Layer.provide(NodeHttpServer.layer(...)),
  Layer.launch,
  NodeRuntime.runMain
)
```

And to call it — the same definitions drive a fully typed client:

```ts
import { HttpApiClient } from "effect/unstable/httpapi"

const client = yield* HttpApiClient.make(Api, { baseUrl: "http://localhost:3000" })

const doc = yield* client.articles.fetch({
  params: { id: Article.Id.make("1") },
  query: { include: ["author"] }     // ← include paths are typed literals; typos don't compile
}).pipe(
  Effect.catchTag("ArticleNotFound", (e) => /* e.id is typed */ …)
)
// doc.data.attributes.createdAt is a Date; doc.included is typed
```

### Narrowing `included` by the requested include paths

The spec guarantees that a server "MUST NOT include unrequested resource objects", so the client
knows *statically* what `included` can contain — `JsonApi.narrowIncluded` exposes that:

```ts
const include = ["author"] as const

const doc = yield* client.articles.fetch({
  params: { id: Article.Id.make("1") },
  query: { include }
}).pipe(JsonApi.narrowIncluded(Article, include))

doc.included
// ^ ReadonlyArray<Person> — not Person | Comment | Tag.
//   doc.included[0].attributes.firstName is accessible without narrowing on `type`.
```

Dotted paths include the intermediate resources (`["comments.author"]` → `Comment | Person`), and
requesting nothing narrows `included` to `never`. This is a type-level operation with no runtime
cost; the response is still decoded against the endpoint's full schema, so a non-compliant server
fails loudly instead of lying.

## Query parameters

| Family         | Wire form                          | Decoded form                                          |
| -------------- | ---------------------------------- | ----------------------------------------------------- |
| `include`      | `?include=author,comments.author`  | `ReadonlyArray<"author" \| "comments" \| "comments.author">` — literal paths from the relationship graph |
| `fields[TYPE]` | `?fields[articles]=title,body`     | `{ articles?: ReadonlyArray<"title" \| "body" \| …> }` — closed per-type key sets |
| `sort`         | `?sort=-createdAt,title`           | `[{ field: "createdAt", direction: "desc" }, …]`      |
| `page[*]`      | `?page[offset]=0&page[limit]=10`   | `{ offset?: number, limit?: number }` (`Page.Offset`, `Page.Number`, `Page.Cursor`, or custom) |
| `filter[*]`    | `?filter[author]=9`                | user-defined schema per filter key                    |

Unknown include paths, unknown sparse-fieldset names and unknown sort fields fail decoding — which
the schema-error middleware turns into a spec-compliant **400 JSON:API error document**.

## Spec compliance, by construction

| JSON:API v1.1 rule | How it's enforced |
| --- | --- |
| Media type `application/vnd.api+json` | baked into every document/payload/error schema |
| 415 on parameterised request `Content-Type`; 406 on unacceptable `Accept` | middleware attached to every endpoint; providing it is required by the type system |
| Error bodies are error documents | only `JsonApi.Error` classes can be declared as endpoint errors |
| Top-level document holds exactly one of `data` / `errors` / `meta` | success schemas only ever contain `data`; error schemas only `errors` — mixing is unrepresentable |
| Resource objects have `type` and `id`; ids are not interchangeable across types | `Resource` always emits the type tag and a per-type branded id |
| Create requests may omit `id` and send `lid` | `createPayload` derivation |
| Update requests require `id`, attributes are partial | `updatePayload` derivation |
| Relationships hold at least one of `data` / `links` / `meta` | `toOne` / `toMany` schemas require resource linkage (`data`) |
| Compound documents: no duplicate resources, full linkage | `JsonApi.data` / `JsonApi.collection` builders (runtime check) |
| `errors` array is never empty | non-empty check on the error document schema |
| 200 / 201 / 204 status codes per operation | set by the endpoint constructors |
| Pagination / sorting / sparse fieldsets / inclusion / filtering query families | typed query schemas derived from the resource definition |

## Examples

Complete runnable examples (resources, errors, api, in-memory handlers) live in
[`examples`](./examples), each exercised end-to-end by a test:

| Example | What it shows | Test |
| --- | --- | --- |
| [`examples/blog`](./examples/blog) | The classic JSON:API blog: articles, people, comments; full CRUD; heterogeneous search | [`test/blog.test.ts`](./test/blog.test.ts) |
| [`examples/github`](./examples/github) | A GitHub-like API: users, repositories, issues, pull requests, labels; a 5-resource relationship graph with 2-hop include paths (`repository.owner`); per-group endpoint subsets (read-only users/pulls, no issue deletion); typed filters over closed attribute sets (`filter[state]=open`); page-number pagination; 403/404/422 domain errors; global search across three resource types | [`test/github.test.ts`](./test/github.test.ts) |

## Metadata

`meta` is free-form by spec, so every `meta` member accepts arbitrary records by default. Tighten
any of them by passing a schema:

```ts
// Resource-level meta (on every resource object)
const Article = JsonApi.Resource("articles", {
  attributes: { … },
  meta: Schema.Struct({ rank: Schema.Int })
})

// Document-level meta (per endpoint, e.g. pagination totals)
JsonApi.Endpoint.list(Article, { meta: Schema.Struct({ total: Schema.Int }) })

// Or on a document schema directly
Article.collection({ meta: Schema.Struct({ total: Schema.Int }) })
```

Relationship and resource-identifier `meta` currently accept free-form records (untyped).

## Limitations

- **Sparse fieldsets are advisory**: `?fields[TYPE]=` is decoded, validated and handed to your
  handler, but attribute projection in responses is handler logic (automatic projection would
  require post-processing responses against request state).
- **Include paths are typed to a depth of 2 hops** (`"comments.author"` works,
  `"comments.author.employer"` doesn't) — a TypeScript recursion-depth trade-off. The runtime
  validation matches the same set.
- **Server-side `included` narrowing is not possible**: a handler's return type cannot depend on
  the runtime value of `?include=` (that's dependent typing). Client-side narrowing is provided
  via `JsonApi.narrowIncluded`.
- **Relationship and identifier `meta` are untyped** (free-form records); resource and document
  meta are typed via options.
- **Mutually recursive resources** (A ↔ B) need an explicit type annotation on one of the two
  relationship thunks, due to TypeScript's circular-inference limits.
- **`narrowIncluded` is single-resource**: narrowing the `included` of heterogeneous (search)
  responses by include paths is not yet supported.
- **Relationship endpoints** (`/articles/1/relationships/author`) and the atomic operations
  extension are not yet modelled.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © Thomas Foster

## Links

- [JSON:API Specification](https://jsonapi.org/format/1.1/)
- [Effect Documentation](https://effect.website/)
- [GitHub Repository](https://github.com/thomasfosterau/effect-jsonapi)
