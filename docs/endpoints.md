# Errors and endpoints

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

## Endpoints & groups — conventions baked in

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

## The create's `Location` header

A `201` from `Endpoint.create` carries a `Location` header naming the created resource (JSON:API v1.1 §Creating Resources → 201 Created, a SHOULD). Nothing in the handler sets it: the `Middleware.CreatedLocation` middleware the constructor attaches copies it, verbatim, from the document the endpoint encoded — the created resource's `data.links.self`, or, when the resource has none, the document's top-level `links.self` (a link object contributes its `href`). Give the created resource its own `self` link and the spec's MUST — when the resource carries `links.self`, it and `Location` match — holds by construction:

```ts
// In the `create` handler, once the new `article` is stored:
const self = `/articles/${article.id}`;
// 201, `Location: /articles/42`, and `data.links.self` the same URL
return Effect.succeed(Handlers.data({ ...article, links: { self } }, { self }));
```

With neither link the header is omitted, and so is a link that isn't a URI-reference (a space, a control character or a non-ASCII character in it), rather than sent malformed. Only a `201` is touched: a create answering another [`status`](#overriding-the-write-status) is left alone, as is a response that already carries `Location`, and a body that isn't a JSON document (or isn't settled bytes) passes through unchanged rather than failing the request. The middleware sits inside `Idempotency.Middleware`, so a [replayed](#idempotent-writes-idempotency-key) `201` keeps its `Location`. `Middleware.layer`, `Middleware.layerWith` and `Middleware.layerHostNegotiated` all provide it, and `Registry.layer` / `Registry.webHandler` provide it beneath whatever `middleware` they are given; any other api that composes its own middleware set adds `Middleware.CreatedLocationLive`. The header is not declared on the endpoint, so the typed client does not surface it.

## Overriding the write payload

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

## Overriding the success document

`Endpoint.get`, `create` and `update` bind their response to the resource's `document()`, and `Endpoint.list` to its `collection()` — the resource is the single source of truth for what a handler returns. Some apis need the response to be a **wire variant** of the resource rather than the resource itself: the assembler stringifies every link before the document leaves the server, so `links.self` is a plain string on the wire, while the resource's own `links.self` is `Document.Link`, which decodes an absolute reference to a `URL`. A generated client then hands every call site a `URL` where it wants a `string`.

Pass `success` to supply that schema. It defaults to today's `document()` / `collection()`, so existing endpoints are unchanged; only the response moves — path, params, query parameters, request payload, errors and middleware stay exactly as they were. Any schema works, exactly as with `payload`: the document envelope is untouched, so `Handlers.offsetPaginationLinks` and the rest of the handler helpers still apply.

With `include` on (`true` or a `Query.IncludeOptions`), the default document's `included` covers every type a legal include path reaches, not only the resource's direct targets (see [Constraining the advertised include paths](query.md#constraining-the-advertised-include-paths)). A hand-written `success` replaces that union with whatever its own `included` admits, and `Document.DataDocument` / `CollectionDocument` admit nothing in `included` unless you pass the union. So an override on an endpoint that advertises `comments.author` must admit `Comment` and `Person` itself, or the response for that path fails to encode. `Include.included(Article, { include })` builds that union: given the resource and the endpoint's `include` option, it returns the `included` union the default document binds when the endpoint does not declare `fields` (with `fields: true` the default's members are partial, and the helper's stay strict), so it follows the relationship graph rather than drifting from it. A widened `include: boolean` gives what either value admits, as `get` / `list` / `related` do. For a `related` endpoint pass the relationship's target (a `Resource.family` target is passed as the family itself), and for `collection` / `polymorphic` the array of members (`family.members`). The members form mirrors those endpoints, which also give what either value admits under a widened `include: boolean`. Under a declared `Include.Surface` every form returns the surface's own `included`, which is exactly what each endpoint binds. The `Group.resource` example below, whose `get` and `list` default to `include: true`, uses it. On an endpoint that declares `fields`, a hand-written `success` also replaces the default's partial attributes (see [Sparse fieldsets and the default document](handlers.md#sparse-fieldsets-and-the-default-document)).

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
// The `included` union `Endpoint.get(Article, { include: true })` binds by default
const included = Include.included(Article, { include: true });

const articles = Group.resource(Article, {
  endpoints: {
    // `Group.resource` turns `include: true` on for `get` and `list`: their documents
    // admit what `Article`'s include paths reach (`Person` and `Tag`).
    get: { success: Document.DataDocument(WireArticle, { included }) },
    list: { success: Document.CollectionDocument(WireArticle, { included }) },
    create: { success: Document.DataDocument(WireArticle) },
    update: { success: Document.DataDocument(WireArticle) },
  },
});
```

## Overriding the write status

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

## Overriding the payload media type

Every body the package declares is `application/vnd.api+json`, request bodies included — and the router matches an incoming `Content-Type` against that registration, answering **415** on a mismatch. That is right for an api that owns its URLs and negotiates §6 itself.

It is wrong for an api whose **host** negotiates instead. Such a host enforces §6 at its own seam — `Middleware.negotiate` is exactly that, reused outside the constructors — and then hands the router a request relabelled `application/json`, because that is what the rest of its URL space speaks. The request the host just admitted would then be 415'd by the router before any handler sees it.

Pass `payloadMediaType` to register the request body under the label the host actually dispatches. It defaults to `application/vnd.api+json`, so existing endpoints are unchanged; the payload schema, the **response** media type, path, params, errors and middleware all stay as they were. Pair it with [`Middleware.layerHostNegotiated`](handlers.md), or the package's own §5 check will reject what the host admitted:

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

## Overriding the delete response

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

## Overriding the read query

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

[`Query.bracketPageKeys`](query.md#bracketing-page-keys-on-a-query-struct-you-own) is what keeps the page cursor spec-canonical on the wire (`page[offset]` / `page[limit]`) while the handler still sees `{ offset, limit }` — but any schema works, bracketed or not.

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

## Generating a whole group from a resource

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

Defaults emit all five CRUD operations and every relationship's endpoints with `include` / `fields` / `sort` enabled; `page` and `filter` stay opt-in (their semantics are application-defined), as do compound relationship documents (`relationshipInclude`) and their sparse fieldsets (`relationshipFields`), and `errors` is applied to every generated endpoint. Every default is overridable, globally or per endpoint / relationship — see `Endpoint.ResourceOptions`.

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

## Relationship & related endpoints

The spec defines two URL families per relationship; both are first-class:

| Constructor | Method & path | Payload | Success |
| --- | --- | --- | --- |
| `Endpoint.related` | `GET /<type>/:id/<name>` | — | 200 — the related resource(s) themselves: a single-resource document (to-one) or a collection document with full query support (to-many) |
| `Endpoint.getRelationship` | `GET /<type>/:id/relationships/<name>` | — | 200 — a linkage document (`data` is identifiers, never full resources); with `include`, a compound one |
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

`Handlers.paginatedRelationship(type, id, name)` builds a `Relationship.paginated` relationship object: `{ links: { self, related } }` with `self` = `/<type>/<id>/relationships/<name>` and `related` = `/<type>/<id>/<name>`. A relationship `self` link promises that the server answers it, so write it only when the API declares that relationship endpoint (`Endpoint.getRelationship`). The `self` option controls it: omitted, it is the default path above; a string replaces it verbatim and is not validated (the empty string included); `false` leaves it out, and the value's type then has no `self`. `related` is always written, and always as the default `/<type>/<id>/<name>`: the option never changes it, so a custom `self` under another prefix, as in the `/v2` example below, still pairs with an unprefixed `related`. The option touches only the relationship object: the relationship endpoint's own `first`/`next`/`prev`/`last` links come from its handler's `Handlers.offsetPaginationLinks` (or sibling) call, from the path that handler serves.

```ts
Handlers.paginatedRelationship("articles", id, "comments");
// → { links: { self: "/articles/1/relationships/comments", related: "/articles/1/comments" } }
Handlers.paginatedRelationship("articles", id, "comments", { self: false });
// → { links: { related: "/articles/1/comments" } } — no relationship endpoint declared
Handlers.paginatedRelationship("articles", id, "comments", {
  self: "/v2/articles/1/relationships/comments",
});
// → { links: { self: "/v2/articles/1/relationships/comments", related: "/articles/1/comments" } }
```

### Compound relationship documents

A relationship document may be a compound document ([§Inclusion of Related Resources](https://jsonapi.org/format/1.1/#fetching-includes)): `GET /articles/1/relationships/comments?include=comments.author` answers the comment identifiers as `data`, and the comments and their authors in `included`. Pass `getRelationship` an `include` option, shaped as the other read endpoints' is. The paths are the **parent's**, rooted at the relationship, so each one's first segment is the relationship's name:

- `include: true` legalises the parent's include paths that start with the relationship, to a depth of 2 from the parent (`comments`, `comments.author`);
- `{ depth }` bounds that derivation, counted from the parent (`1` is the relationship alone), and `{ paths }` is an explicit allow-list whose every path must be rooted at the relationship;
- an `Include.Surface` over the parent whose paths are all rooted at the relationship (`Include.make(Article, { comments: Include.nested(Comment, { author: Person }) })`) also derives the `included` union.

Any other path is a 400 naming the legal ones, and a path outside the relationship is a compile error. The success document gains an optional `included` admitting every resource the legal paths reach; without `include` it has none, as before. `Handlers.linkage` takes the members as `included`: it deduplicates them among themselves but not against the identifiers (an identifier is not a resource object, so `comments:5` in both is no duplicate), and checks full linkage from the identifiers themselves. `Assemble.relationship`'s `included` reaches the wire the same way.

**Paginated relationships.** A `paginated` relationship is never an include path of its parent, but on its own relationship endpoint its linkage _is_ the primary data, so its paths are derived as if it were a `many` (`Endpoint.RelationshipIncludeBase`): its name and the paths rooted at it, under `true`, `{ depth }` and `{ paths }` alike, with the `included` union and the `fields[TYPE]` types to match. A `paginated` relationship further along a path is still never crossed. With `page`, the identifiers are one page, and `?include=comments` means the comments **on that page** (and, for `comments.author`, their authors) — not the whole relationship: full linkage is checked from the identifiers, so a comment another page names fails it. Hand `Assemble.relationship` a parent whose `relationships[key]` carries that page (`{ data: pageIds }`), since a paginated relationship object has no `data`. A declared `Include.Surface` cannot name a `paginated` relationship, so it is the one form that does not apply.

```ts
// `comments` is Relationship.paginated(() => Comment)
Endpoint.getRelationship(Article, "comments", { page: Query.Page.Offset, include: true });
// GET /articles/1/relationships/comments?include=comments.author&page[limit]=10

.handle("commentsRelationship", ({ params, query }) => {
  const page = loadCommentPage(params.id, query.page); // this page's comments
  return Effect.succeed(
    Handlers.linkage(page.map((comment) => Comment.ref(comment.id)), {
      // the page's comments, and their authors for `comments.author`
      included: query.include === undefined ? undefined : withAuthors(page, query.include),
    }),
  );
})
```

Pass `fields: true` beside `include` for sparse fieldsets on those members ([§Sparse Fieldsets](https://jsonapi.org/format/1.1/#fetching-sparse-fieldsets) "applies to any endpoint that responds with resources as primary or included data"). The primary data is resource identifiers, which have no fields, so `fields[<target type>]` narrows only the `included` members of that type, and the types `fields[TYPE]` can name are exactly those the legal include paths reach (`Endpoint.RelationshipFieldsetTypes`): under `include: true` on `comments`, `fields[comments]` and `fields[people]`. The parent's own type is not among them (unless a path reaches it), since the document carries no resource object of it, so `fields[articles]` is a 400 like any other undeclared type; without `include` nothing can be included and no type is declared. Those members then admit any subset of their fields, as on the resource endpoints ([sparse fieldsets and the default document](handlers.md#sparse-fieldsets-and-the-default-document)), so the handler projects with `onResource: Handlers.project(query.fields)`, which leaves the identifiers alone, and `Assemble.relationship` takes the request's fieldsets as `fields`. The query is built with `Query.schema`'s `fields` allow-list form — `fields: ["comments", "people"]` declares those types alone — since it is the parent's query but not the parent's document.

```ts
Endpoint.getRelationship(Article, "tags", { include: true, fields: true });
// GET /articles/:id/relationships/tags?include=tags&fields[tags]=name

.handle("tagsRelationship", ({ params, query }) =>
  loadArticle(params.id).pipe(Effect.map((article) => {
    const tags = article.relationships?.tags.data ?? [];
    return Handlers.linkage(tags, {
      // `undefined` without `?include=` (no `included` member)
      included: query.include === undefined ? undefined : loadTags(tags),
      // narrows the `included` tags; projecting an identifier is a no-op
      onResource: Handlers.project(query.fields),
      self: Handlers.relationshipLink("articles", article.id, "tags"),
    });
  })))
```

The relationship endpoints `Endpoint.resource` / `Group.resource` generate leave `include` off unless asked. `relationshipInclude` sets it for all of them — `true` or a `{ depth }` bound, each relationship's paths rooted at it — and a relationship's own `relationshipInclude` overrides that, taking any of the forms above (a `{ paths }` allow-list or a declared surface names one relationship's paths, so those are per-relationship only). It is separate from the top-level `include`, which governs `get`, `list` and the `related` endpoints. On a `paginated` relationship it legalises that relationship's paths as on a `many` ([above](#compound-relationship-documents)).

`relationshipFields` is their `fields: true` the same way, pairing with `relationshipInclude` as `fields` pairs with `include`: `true` at the top level for every generated `getRelationship`, a relationship's own `relationshipFields` overriding it. Each endpoint then declares `fields[TYPE]` for the types its own include paths reach, and its handler's `included` members admit any subset of their fields, so it answers with `onResource: Handlers.project(query.fields)`; an endpoint without include paths declares none. It is off by default and independent of the top-level `fields`, which governs `get`, `list` and the `related` endpoints.

```ts
const articles = Group.resource(Article, {
  relationshipInclude: true, // every getRelationship endpoint: ?include=<name>…
  relationshipFields: true, // …&fields[TYPE]=… for each type those paths reach
  relationships: {
    comments: { relationshipInclude: { paths: ["comments.author"] } }, // this one: exactly these
    tags: { relationshipInclude: false }, // this one: off
    author: { relationshipFields: false }, // this one: ?include= but no fieldsets
  },
});
```

## Heterogeneous endpoints (search, feeds)

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
  if (result.type === "articles") result.attributes.title; // Article
  else result.attributes.firstName; // Person
}
```

The `included` union spans every searched resource's non-`paginated` relationship targets (and, with `include` on, every resource a legal include path reaches), and query features (`fields[TYPE]`, `include`, `sort`) are derived across **all** of the resources in the union.

## Atomic operations

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
| `.add` | `{ op: "add", data: { type, lid?, attributes, relationships } }` — no `id` (a client-generated `data.id` is refused with 403, [below](#client-generated-ids-in-an-add)); `one` relationships required, `paginated` excluded |
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

### Client-generated ids in an `add`

An `add` operation's `data` declares no `id`, as `createPayload`'s doesn't, so the default request document does not support client-generated ids. An `add` that sends one is refused rather than having its id dropped: `Middleware.SchemaErrorsLive` answers the whole request with a 403 whose `source.pointer` is `/atomic:operations/N/data/id`, and the handler never runs, so no operation is performed (the extension answers a failed operation as the base specification does, and §Client-Generated IDs requires the 403). The decode stops at the first operation that fails, so that operation decides the answer: a malformed operation before it is a 400, one after it is not reached.

To support client ids, pass `Endpoint.operations` a `payload` whose `add` declares an `id`. The handler then receives it, and answering a duplicate with 409 is the handler's to do:

```ts
const AddArticle = Atomic.AddOperation(Article);
const AddArticleWithId = Schema.Struct({
  ...AddArticle.fields,
  data: Schema.Struct({ ...AddArticle.fields.data.fields, id: Schema.optionalKey(Schema.String) }),
});

Endpoint.operations([Article], {
  payload: Schema.Struct({
    // `AddArticleWithId` first, so an `add` carrying an id decodes through it.
    "atomic:operations": Schema.Array(
      Schema.Union([AddArticleWithId, ...Atomic.Operations([Article]).members]),
    ).check(Schema.isMinLength(1)),
  }),
});
```

Every endpoint automatically:

- serves and accepts **`application/vnd.api+json`**
- declares its errors as **JSON:API error documents** at the right status
- carries the **content-negotiation middleware** (415 on parameterised request media types, 406 on unacceptable `Accept` headers) and the **schema-error middleware** (malformed params/query/payloads become JSON:API 400 documents; a handler response that fails its own endpoint's schema stays a server defect — reported, and answered with the opaque JSON:API 500 `ServerErrors.SERVER_ERROR`) — and because they're real `HttpApiMiddleware` services, **the api won't build until you provide them**: forgetting is a compile error, not a runtime surprise
- rejects a **reserved query parameter** it does not process: JSON:API 1.1 reserves parameter names made only of the letters a-z for the specification, so `?unknown=1` (or `?foo[bar]=1` — the family's base name is what counts) is a 400 naming it in `source.parameter`, as is a parameter whose base name is not a legal member name (`?foo!=1`, `?page.limit=1`) or names an extension's parameter (`?ext:param=1`), neither of which follows the specification's naming conventions — except jQuery's `?_=` cache-buster, which the default allow-list admits — while an implementation-specific name, a legal member name carrying a character outside a-z (`?fooBar=1`, `?x-trace=1`), is ignored as before. Any all-lowercase name the endpoint's `query` schema declares is left to that schema. The specification's own families — `include`, `fields[TYPE]`, `sort`, `page` and `filter` — are a 400 too on an endpoint that doesn't declare them, or declares them with an empty vocabulary, under the specification's general rule for a parameter the server doesn't know how to process ([Query parameters](query.md)); see [Reserved query parameters](handlers.md#reserved-query-parameters) for the escape hatch for a host's own lowercase names
- documents itself in **OpenAPI** (`OpenApi.fromApi(Api)`) with the JSON:API media type, status codes and bracket query parameters

## Idempotent writes (`Idempotency-Key`)

A `POST` whose response is lost leaves the client unable to tell "it didn't happen" from "it happened and I didn't hear" — retrying duplicates, not retrying loses the write. `lid` does not help: it correlates resources **within** one request, and says nothing about whether the request already ran.

Opt an endpoint in and it accepts an `Idempotency-Key` request header ([the profile](idempotency.md)):

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

JSON:API v1.1 specifies no idempotency mechanism. The header name and the three statuses are the [IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)'s convention; the fingerprint, the replay rule, the key's scope and the retention contract are this package's, published as a profile URI and defined in full in [`docs/idempotency.md`](idempotency.md).
