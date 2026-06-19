# effect-jsonapi

Type-safe, spec-compliant [JSON:API v1.1](https://jsonapi.org/format/1.1/) on [Effect](https://effect.website)'s HttpApi.

[![CI](https://github.com/thomasfosterau/effect-jsonapi/actions/workflows/ci.yml/badge.svg)](https://github.com/thomasfosterau/effect-jsonapi/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@thomasfosterau/effect-jsonapi.svg)](https://www.npmjs.com/package/@thomasfosterau/effect-jsonapi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Installation

```bash
npm install @thomasfosterau/effect-jsonapi effect
```

`effect` is a peer dependency (`>=4.0.0-beta.84`). Node.js 20 or newer is required.

## Overview

`effect-jsonapi` makes it **trivial to comply with the JSON:API spec, invariantly** — compliance
is a property of the construction, not of developer discipline:

- Define each **resource once**; identifiers, create/update payloads, documents, query parameters
  and endpoints are all derived from that single definition.
- Declare each **error once**; you get a tagged Effect error whose wire encoding _is_ a
  spec-compliant JSON:API error document with the right HTTP status.
- **Endpoints** bake in the conventions: the `application/vnd.api+json` media type, conventional
  paths, spec status codes (200/201/204), typed `include` / `fields[TYPE]` / `sort` / `page[*]` /
  `filter[*]` query parameters, and content-negotiation rules (406/415).
- Everything is a plain Effect `Schema` / `HttpApiEndpoint` / `HttpApiGroup`, so it composes with
  `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi` untouched.

```ts
import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { JsonApi } from "@thomasfosterau/effect-jsonapi"
```

> **Status**: built against `effect@>=4.0.0-beta.84` (the v4 beta). The
> `effect/unstable/httpapi` surface may shift between betas.

## Contents

- [Quick start](#quick-start)
- [1. Resources — the single source of truth](#1-resources--the-single-source-of-truth)
  - [Relationship kinds](#relationship-kinds)
- [2. Errors — declared once, spec-compliant forever](#2-errors--declared-once-spec-compliant-forever)
- [3. Endpoints & groups — conventions baked in](#3-endpoints--groups--conventions-baked-in)
  - [Relationship & related endpoints](#relationship--related-endpoints)
  - [Heterogeneous endpoints (search, feeds)](#heterogeneous-endpoints-search-feeds)
  - [Atomic operations](#atomic-operations)
- [4. Handlers — typed in, validated out](#4-handlers--typed-in-validated-out)
  - [Narrowing `included` by the requested include paths](#narrowing-included-by-the-requested-include-paths)
- [Query parameters](#query-parameters)
- [Spec compliance, by construction](#spec-compliance-by-construction)
- [Examples](#examples)
- [Metadata](#metadata)
- [Limitations](#limitations)

## Quick start

A complete read API — resource, error, endpoints, handlers, server — in one file. Each piece is
expanded in the sections below.

```ts
import { Effect, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { JsonApi } from "@thomasfosterau/effect-jsonapi"

// 1. Define a resource once — identifiers, payloads, documents and query
//    parameters are all derived from this single definition.
const Article = JsonApi.Resource("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String }
})

// 2. Declare an error once — its wire encoding *is* a JSON:API error document.
class ArticleNotFound extends JsonApi.Error<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  fields: { id: Schema.String },
  detail: (e) => `Article ${e.id} not found`
}) {}

// 3. Build endpoints with the JSON:API conventions baked in.
const articles = JsonApi.Group(
  Article,
  JsonApi.Endpoint.fetch(Article, { include: true, errors: [ArticleNotFound] }),
  JsonApi.Endpoint.list(Article, { page: JsonApi.Page.Offset })
)

const Api = HttpApi.make("blog").add(articles)

// 4. Implement handlers — inputs are typed and validated, documents are checked
//    for the compound-document rules. (`loadArticle` / `listArticles` are your
//    own data access returning `Effect`s.)
const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("fetch", ({ params }) => loadArticle(params.id).pipe(Effect.map((article) => JsonApi.data(article))))
    .handle("list", ({ query }) => listArticles(query).pipe(Effect.map((items) => JsonApi.collection(items))))
)

// 5. Wire it up — the api won't build unless the JSON:API middleware is
//    provided, so spec compliance can't be forgotten.
const ApiLive = HttpApiBuilder.layer(Api).pipe(Layer.provide(ArticlesLive), Layer.provide(JsonApi.Middleware.layer))
```

## 1. Resources — the single source of truth

```ts
const Person = JsonApi.Resource("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString
  }
})

const Tag = JsonApi.Resource("tags", {
  attributes: { name: Schema.NonEmptyString }
})

const Comment = JsonApi.Resource("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: {
    author: JsonApi.Relationship.one(() => Person) // a reference, not a string — typos don't compile
  }
})

const Article = JsonApi.Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    createdAt: Schema.DateFromString // ISO string on the wire, Date in your code
  },
  relationships: {
    author: JsonApi.Relationship.one(() => Person), // required to-one
    editor: JsonApi.Relationship.optional(() => Person), // nullable to-one
    tags: JsonApi.Relationship.many(() => Tag), // bounded to-many, inlined
    comments: JsonApi.Relationship.paginated(() => Comment) // unbounded to-many, linked
  }
})
```

### Relationship kinds

Each relationship declares its cardinality _and_ how its data travels — inline
as resource identifiers, or behind a link to a paginated endpoint:

| Constructor              | Cardinality | Wire shape of the relationship object         | In `?include=` | In create payload              |
| ------------------------ | ----------- | --------------------------------------------- | -------------- | ------------------------------ |
| `Relationship.one`       | to-one      | `{ data: identifier }` — never null           | ✓              | **required**                   |
| `Relationship.optional`  | to-one      | `{ data: identifier \| null }`                | ✓              | optional                       |
| `Relationship.many`      | to-many     | `{ data: identifier[] }`                      | ✓              | optional                       |
| `Relationship.paginated` | to-many     | `{ links: { related, self? } }` — **no data** | ✗              | ✗ (use relationship endpoints) |

`one` / `optional` / `many` carry **inline linkage**: clients see the related
identifiers right inside the parent resource and can pull the full resources
into a compound document with `?include=`.

`paginated` is for **unbounded collections** (an article's comments, a user's
repositories): the relationship object carries only a required `related` link
pointing at a paginated collection endpoint (see
[Relationship & related endpoints](#relationship--related-endpoints)).

Everything below is **derived** — never assembled by hand:

| Derived                   | What it is                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Article`                 | the resource object `Schema.Struct` itself (`type`/`id`/`attributes`/…)                                             |
| `Article.Id`              | branded id schema — `Article.Id` values can't be mixed with `Person.Id`                                             |
| `Article.identifier`      | the `{ type: "articles", id }` resource-identifier schema                                                           |
| `Article.ref("1")`        | a typed identifier _value_ — handy for relationship linkage                                                         |
| `Article.localIdentifier` | the `{ type: "articles", lid }` schema — identifies a resource being created (no server id yet)                     |
| `Article.lidRef("a1")`    | a typed local-identifier _value_ — the `lid` counterpart of `ref`                                                   |
| `Article.createPayload`   | `{ data: { type, lid?, attributes, relationships } }` — no `id`; `one` relationships required, `paginated` excluded |
| `Article.updatePayload`   | `{ data: { type, id, attributes? (partial), relationships? } }` — `paginated` excluded                              |
| `Article.document()`      | single-resource document; `included` union derived from the non-paginated relationships                             |
| `Article.collection()`    | collection document (strict array `data`)                                                                           |
| `typeof Article.Type`     | the decoded TypeScript type                                                                                         |

Documents are not limited to one resource type — see
[Heterogeneous endpoints](#heterogeneous-endpoints-search-feeds) for polymorphic collections.

## 2. Errors — declared once, spec-compliant forever

```ts
class ArticleNotFound extends JsonApi.Error<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
  fields: { id: Schema.String }, // typed fields, round-tripped through the wire
  detail: (e) => `Article ${e.id} not found`
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

`JsonApi.BadRequest` (400), `JsonApi.NotAcceptable` (406), `JsonApi.UnsupportedMediaType` (415),
`JsonApi.Forbidden` (403) and `JsonApi.Conflict` (409) are predefined.

## 3. Endpoints & groups — conventions baked in

```ts
const articles = JsonApi.Group(
  Article,
  // GET /articles/:id?include=author,tags&fields[articles]=title
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
  // POST /articles → 201 (client may send a lid; the required author relationship must be present)
  JsonApi.Endpoint.create(Article, { errors: [TitleTaken] }),
  // PATCH /articles/:id (partial attributes)
  JsonApi.Endpoint.update(Article, { errors: [ArticleNotFound] }),
  // DELETE /articles/:id → 204
  JsonApi.Endpoint.remove(Article, { errors: [ArticleNotFound] }),
  // GET /articles/:id/comments — the paginated related collection
  JsonApi.Endpoint.related(Article, "comments", {
    page: JsonApi.Page.Offset,
    errors: [ArticleNotFound]
  }),
  // PATCH /articles/:id/relationships/author — replace the author
  JsonApi.Endpoint.updateRelationship(Article, "author", { errors: [ArticleNotFound] })
)

const Api = HttpApi.make("blog").add(articles)
```

### Relationship & related endpoints

The spec defines two URL families per relationship; both are first-class:

| Constructor                   | Method & path                             | Payload               | Success                                                                                                                                  |
| ----------------------------- | ----------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Endpoint.related`            | `GET /<type>/:id/<name>`                  | —                     | 200 — the related resource(s) themselves: a single-resource document (to-one) or a collection document with full query support (to-many) |
| `Endpoint.fetchRelationship`  | `GET /<type>/:id/relationships/<name>`    | —                     | 200 — a linkage document (`data` is identifiers, never full resources)                                                                   |
| `Endpoint.updateRelationship` | `PATCH /<type>/:id/relationships/<name>`  | replacement linkage   | 200 — the updated linkage                                                                                                                |
| `Endpoint.addRelationship`    | `POST /<type>/:id/relationships/<name>`   | identifiers to add    | 200 — the resulting linkage (to-many only)                                                                                               |
| `Endpoint.removeRelationship` | `DELETE /<type>/:id/relationships/<name>` | identifiers to remove | 204 (to-many only)                                                                                                                       |

Payload and success schemas follow the relationship's kind:

```ts
// `author` is Relationship.one(() => Person):
JsonApi.Endpoint.updateRelationship(Article, "author")
// PATCH payload: { data: PersonIdentifier }          — null doesn't decode (required relationship)

// `editor` is Relationship.optional(() => Person):
JsonApi.Endpoint.updateRelationship(Article, "editor")
// PATCH payload: { data: PersonIdentifier | null }   — null clears the relationship

// `comments` is Relationship.paginated(() => Comment):
JsonApi.Endpoint.related(Article, "comments", { page: JsonApi.Page.Offset, include: true })
// GET /articles/:id/comments?page[offset]=0&page[limit]=10&include=author
// → a paginated collection document of full Comment resources

JsonApi.Endpoint.addRelationship(Article, "comments")
// POST payload: { data: CommentIdentifier[] }

// to-many constructors only accept to-many relationship names:
JsonApi.Endpoint.addRelationship(Article, "author") // ✗ compile error
```

Handlers return linkage documents with `JsonApi.linkage`, and build the
relationship URLs with `JsonApi.relationshipLink` / `JsonApi.relatedLink` /
`JsonApi.paginatedRelationship`:

```ts
.handle("commentsRelationship", ({ params, query }) =>
  loadComments(params.id, query.page).pipe(Effect.map((comments) =>
    JsonApi.linkage(comments.map((c) => Comment.ref(c.id)), {
      self: JsonApi.relationshipLink("articles", params.id, "comments"),
      related: JsonApi.relatedLink("articles", params.id, "comments")
    })
  )))
```

### Heterogeneous endpoints (search, feeds)

`Endpoint.search` builds collection endpoints whose `data` mixes several resource types,
discriminated by their `type` tags — the natural fit for search results, feeds and timelines:

```ts
const search = JsonApi.Group(
  "search",
  // GET /search?filter[q]=bikeshed&include=author&page[offset]=0&page[limit]=10
  JsonApi.Endpoint.search([Article, Person], {
    filter: { q: Schema.String },
    include: true, // include paths span both resources' graphs
    fields: true, // ?fields[articles]= and ?fields[people]=
    page: JsonApi.Page.Offset,
    meta: Schema.Struct({ total: Schema.Int })
  })
)

const Api = HttpApi.make("blog").add(articles).add(search)

// Handlers return mixed collections; clients discriminate on `type`:
for (const result of doc.data) {
  if (result.type === "articles")
    result.attributes.title // Article
  else result.attributes.firstName // Person
}
```

The `included` union spans every searched resource's relationship targets, and query features
(`fields[TYPE]`, `include`, `sort`) are derived across **all** of the resources in the union.

### Atomic operations

`Endpoint.operations` models the [atomic operations extension](https://jsonapi.org/ext/atomic/):
one request carrying an ordered list of operations — creating, updating and deleting resources or
their relationships — processed all-or-nothing:

```ts
const operations = JsonApi.Group(
  "operations",
  // POST /operations with an atomic:operations document
  JsonApi.Endpoint.operations([Article, Comment], { errors: [OperationFailed] })
)

const Api = HttpApi.make("blog").add(articles).add(operations)
```

Like everything else, the operations a resource supports are **derived** from its definition —
`JsonApi.Atomic.operationsFor(Article)` exposes them as a named record of schemas:

| Derived operation                                                                             | Wire form                                                                                                             |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `.add`                                                                                        | `{ op: "add", data: { type, lid?, attributes, relationships } }` — `one` relationships required, `paginated` excluded |
| `.update`                                                                                     | `{ op: "update", data: { type, id \| lid, attributes?, relationships? } }` — `paginated` excluded                     |
| `.remove`                                                                                     | `{ op: "remove", ref: { type, id \| lid } }`                                                                          |
| `.relationships.author.update` (per `one` relationship)                                       | `{ op: "update", ref: { type, id \| lid, relationship }, data: ref }` — never null                                    |
| `.relationships.editor.update` (per `optional` relationship)                                  | `{ op: "update", ref: { type, id \| lid, relationship }, data: ref \| null }`                                         |
| `.relationships.comments.add` / `.update` / `.remove` (per `many` / `paginated` relationship) | `{ op, ref: { type, id \| lid, relationship }, data: [refs] }`                                                        |

`paginated` relationships — which carry no inline linkage — are managed exactly this way: their
membership is changed through relationship operations (or relationship endpoints), never inside a
resource's `relationships` member.

Clients build requests with the typed operation constructors — note the lid refs
(`Article.lidRef` / `Comment.lidRef`) linking operations within the same request:

```ts
const doc =
  yield *
  client.operations.operations({
    payload: JsonApi.Atomic.request(
      // 1. create an article; it has no id yet, so it declares a lid.
      //    `author` is a required (`one`) relationship, so it must be present.
      JsonApi.Atomic.add(Article, {
        lid: "a1",
        attributes: { title: "Atomic bikeshedding", body: "…", createdAt: new Date() },
        relationships: {
          author: { data: Person.ref("9") },
          tags: { data: [Tag.ref("1")] }
        }
      }),
      // 2. create a comment...
      JsonApi.Atomic.add(Comment, {
        lid: "c1",
        attributes: { body: "First!" },
        relationships: { author: { data: Person.ref("9") } }
      }),
      // 3. ...and link it into the new article's paginated comments relationship —
      //    both sides referenced by lid
      JsonApi.Atomic.addToRelationship(Article, { lid: "a1" }, "comments", [Comment.lidRef("c1")]),
      // 4. to-one relationship operations replace linkage (`one`: never null)
      JsonApi.Atomic.updateRelationship(Comment, "5", "author", Person.ref("9"))
    )
  })

doc["atomic:results"] // one result per operation, in order; `data` is typed Article | Comment
```

Handlers pattern-match over the decoded operation union — the `targetsResource` /
`targetsRelationship` guards are curried, so they drop straight into Effect's `Match` module and
narrow each case to fully typed `data` / `ref`; `JsonApi.lidMap()` tracks the server-assigned ids
of lid-created resources:

```ts
const OperationsLive = HttpApiBuilder.group(Api, "operations", (handlers) =>
  handlers.handle("operations", ({ payload }) =>
    Effect.gen(function*() {
      const lids = JsonApi.lidMap()
      const entries = []
      for (const operation of payload["atomic:operations"]) {
        entries.push(Match.value(operation).pipe(
          Match.when(JsonApi.Atomic.targetsRelationship(Article, "comments"), (op) => {
            // op.data is ReadonlyArray<comment ref>; op.op is "add" | "update" | "remove"
            return JsonApi.Atomic.emptyResult
          }),
          Match.when(JsonApi.Atomic.targetsResource(Article), (op) =>
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
                    comments: JsonApi.paginatedRelationship("articles", id, "comments")
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
      return JsonApi.Atomic.results(entries)
    })))
```

Because the extension uses the JSON:API media type with an `ext` parameter, provide the
middleware with the extension declared:

```ts
Layer.provide(JsonApi.Middleware.layerWith({ extensions: [JsonApi.Atomic.EXTENSION_URI] }))
```

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

Pagination links are built with `JsonApi.offsetPaginationLinks` (for `Page.Offset`) and
`JsonApi.numberPaginationLinks` (for `Page.Number`), which emit the spec's `first` / `prev` /
`next` / `last` top-level links from the request's page parameters and the total count.

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
knows _statically_ what `included` can contain — `JsonApi.narrowIncluded` exposes that:

```ts
const include = ["author"] as const

const doc =
  yield *
  client.articles
    .fetch({
      params: { id: Article.Id.make("1") },
      query: { include }
    })
    .pipe(JsonApi.narrowIncluded(Article, include))

doc.included
// ^ ReadonlyArray<Person> — not Person | Comment | Tag.
//   doc.included[0].attributes.firstName is accessible without narrowing on `type`.
```

Dotted paths include the intermediate resources (`["comments.author"]` → `Comment | Person`), and
requesting nothing narrows `included` to `never`. This is a type-level operation with no runtime
cost; the response is still decoded against the endpoint's full schema, so a non-compliant server
fails loudly instead of lying.

## Query parameters

| Family         | Wire form                         | Decoded form                                                                                             |
| -------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `include`      | `?include=author,comments.author` | `ReadonlyArray<"author" \| "comments" \| "comments.author">` — literal paths from the relationship graph |
| `fields[TYPE]` | `?fields[articles]=title,body`    | `{ articles?: ReadonlyArray<"title" \| "body" \| …> }` — closed per-type key sets                        |
| `sort`         | `?sort=-createdAt,title`          | `[{ field: "createdAt", direction: "desc" }, …]`                                                         |
| `page[*]`      | `?page[offset]=0&page[limit]=10`  | `{ offset?: number, limit?: number }` (`Page.Offset`, `Page.Number`, `Page.Cursor`, or custom)           |
| `filter[*]`    | `?filter[author]=9`               | user-defined schema per filter key                                                                       |

Unknown include paths, unknown sparse-fieldset names and unknown sort fields fail decoding — which
the schema-error middleware turns into a spec-compliant **400 JSON:API error document**.

## Spec compliance, by construction

| JSON:API v1.1 rule                                                                                               | How it's enforced                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Media type `application/vnd.api+json`                                                                            | baked into every document/payload/error schema                                                                                                          |
| 415/406 on media type parameters other than `ext` / `profile` (or unsupported extensions)                        | middleware attached to every endpoint; providing it is required by the type system                                                                      |
| Error bodies are error documents                                                                                 | only `JsonApi.Error` classes can be declared as endpoint errors                                                                                         |
| Top-level document holds exactly one of `data` / `errors` / `meta`                                               | success schemas only ever contain `data`; error schemas only `errors` — mixing is unrepresentable                                                       |
| Resource objects have `type` and `id`; ids are not interchangeable across types                                  | `Resource` always emits the type tag and a per-type branded id                                                                                          |
| Create requests may omit `id` and send `lid`                                                                     | `createPayload` derivation                                                                                                                              |
| Update requests require `id`, attributes are partial                                                             | `updatePayload` derivation                                                                                                                              |
| Relationships hold at least one of `data` / `links` / `meta`                                                     | `one` / `optional` / `many` schemas require resource linkage (`data`); `paginated` schemas require `links.related`                                      |
| Relationship endpoints: GET/PATCH on to-one, GET/POST/PATCH/DELETE on to-many                                    | `Endpoint.fetchRelationship` / `updateRelationship` / `addRelationship` / `removeRelationship`; add/remove only constructible for to-many relationships |
| Related resource endpoints (`related` links)                                                                     | `Endpoint.related` — single-resource document for to-one, paginated collection for to-many                                                              |
| Compound documents: no duplicate resources, full linkage                                                         | `JsonApi.data` / `JsonApi.collection` builders (runtime check)                                                                                          |
| Compound documents never inline unbounded relationships                                                          | `paginated` relationships are excluded from `?include=` paths and `included` unions by construction                                                     |
| `errors` array is never empty                                                                                    | non-empty check on the error document schema                                                                                                            |
| 200 / 201 / 204 status codes per operation                                                                       | set by the endpoint constructors                                                                                                                        |
| Pagination / sorting / sparse fieldsets / inclusion / filtering query families                                   | typed query schemas derived from the resource definition                                                                                                |
| Atomic operations extension: `atomic:operations` / `atomic:results` documents, lid refs, relationship operations | `Endpoint.operations` + `JsonApi.Atomic` schemas derived from resource definitions                                                                      |

## Examples

Complete runnable examples (resources, errors, api, in-memory handlers) live in
[`examples`](./examples). Each is a **standalone package** in the pnpm workspace —
it depends on `@thomasfosterau/effect-jsonapi` and carries its own tests, so you
can lift any one out as a starting point. Run them all from the repo root with
`pnpm test`, or a single one with `pnpm --filter @thomasfosterau/effect-jsonapi-example-northwind test`.

| Example                                      | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Test                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| [`examples/blog`](./examples/blog)           | The classic JSON:API blog: articles, people, tags, comments; full CRUD; a required (`one`) author, inlined (`many`) tags and a paginated comment feed with attach/detach relationship endpoints; heterogeneous search; an atomic operations endpoint with all-or-nothing semantics and lid resolution                                                                                                                                                                                                                                                                                                                                                                                                                      | [`blog/test`](./examples/blog/test)           |
| [`examples/github`](./examples/github)       | A GitHub-like API: users, repositories, issues, issue comments, pull requests, labels; all four relationship kinds (required `owner`/`author`, nullable `assignee`, inlined `labels`, paginated `comments`); issue triage via relationship endpoints (assign/unassign, add/remove/replace labels); 2-hop include paths (`repository.owner`); per-group endpoint subsets; typed filters over closed attribute sets; page-number pagination; 403/404/422 domain errors; global search across three resource types                                                                                                                                                                                                            | [`github/test`](./examples/github/test)       |
| [`examples/northwind`](./examples/northwind) | A Northwind Traders e-commerce API: categories, suppliers, shippers, customers, territories, employees, products, orders and line items; all four relationship kinds laid out as an acyclic graph (required `category`/`supplier`/`customer`/`employee`, nullable `shipper`, inlined `territories`, a paginated line-item feed); the reverse directions (a category's products, a customer's orders) and the self-referential reporting hierarchy modelled as `filter[…]` collection endpoints; product CRUD with typed numeric price-range filters; offset/limit pagination; territory assignment and order shipping via relationship endpoints; 404/409 domain errors; global catalog search across three resource types | [`northwind/test`](./examples/northwind/test) |

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
- **Mutually recursive resources** (A ↔ B) are not supported: TypeScript cannot infer two resource
  types that reference each other. Model one direction as a relationship and the reverse direction
  as a filtered collection endpoint (e.g. `GET /articles?filter[author]=9`) or a related endpoint
  on the side that owns the relationship.
- **`narrowIncluded` is single-resource**: narrowing the `included` of heterogeneous (search)
  responses by include paths is not yet supported.
- **Atomic operations requests are accepted with or without the `ext` media type parameter**:
  spec-compliant clients send `application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"`
  (accepted once the middleware declares the extension), but the bare media type is not rejected.
  Responses always carry the parameter.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © Thomas Foster

## Links

- [JSON:API Specification](https://jsonapi.org/format/1.1/)
- [Effect Documentation](https://effect.website/)
- [GitHub Repository](https://github.com/thomasfosterau/effect-jsonapi)
