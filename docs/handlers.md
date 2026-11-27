# Handlers

```ts
import { Handlers } from "@thomasfosterau/effect-jsonapi"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      //                 ^ params.id is a branded Article id
      //                         ^ query.include / query.fields are typed & validated
      loadArticle(params.id).pipe(
        Effect.flatMap((article) =>
          // walks `?include=` one level at a time, batched per type
          // `None` when the request carried no `?include=`: leave the member out
          Handlers.resolveIncluded(article, Option.fromUndefinedOr(query.include), targets).pipe(
            Effect.map(Option.match({
              onNone: () => Handlers.data(article, { self: `/articles/${article.id}` }),
              onSome: (included) =>
                Handlers.data(article, { included, self: `/articles/${article.id}` })
            }))
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

The document builders (`Handlers.data` / `Handlers.collection`) enforce the compound-document rules at runtime: `included` is **deduplicated** by `(type, id)` — against itself and against the primary `data`, so a resource that is both a hit and an include target is emitted once, as primary data — and checked for **full linkage** (every included resource must be reachable from the primary data through resource linkage), with the spec's one exemption: a relationship a sparse fieldset excludes still counts as the linkage it would otherwise carry ([§Compound Documents](https://jsonapi.org/format/1.1/#document-compound-documents); see [the per-resource transform pass](#the-per-resource-transform-pass-onresource)). The builders check the value they return; encoding through the endpoint's schema then drops any relationship the resource does not declare, so `Middleware.SchemaErrorsLive` checks full linkage again on the document as encoded and answers a violation with a JSON:API 500. Any `included` array is emitted, even an empty one or one the dedupe empties — a response to a request carrying `include` MUST have an `included` key, "even if that `included` key holds an empty array" ([§Fetching Includes](https://jsonapi.org/format/1.1/#fetching-includes)) — so pass an array whenever the request carried `include`, and leave the option out when it did not, which omits the member. Their `onResource` option applies per-resource processing — sparse fieldsets, computed `meta` — uniformly across the whole document ([below](#the-per-resource-transform-pass-onresource)).

## Resolving `included` — one batch per level

`Handlers.resolveIncluded` is the other half: the walk that _produces_ `included` from the paths the client requested. It takes the primary data (one resource, or a whole page), the validated `include` paths, and a registry of **batch loaders keyed by resource type** — and nothing else. There is no service to provide and no runtime to set up; it is a plain `Effect` a handler composes.

```ts
// One loader per type. Each is called once per level, with every id that level
// collected — so each is a single `WHERE id IN (…)`, never a lookup per row.
const targets = {
  people: (ids: ReadonlyArray<string>) => db.people.byIds(ids),
  tags: (ids: ReadonlyArray<string>) => db.tags.byIds(ids),
  comments: (ids: ReadonlyArray<string>) => db.comments.byIds(ids),
};

Handlers.resolveIncluded(page, Option.fromUndefinedOr(query.include), targets, {
  concurrency: 4,
  depth: 2,
});
// → Effect<Option<ReadonlyArray<Person | Tag | Comment>>, …>
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
| **`Option.none()` when unasked** | So the caller omits the member. `[]` is the different statement "your walk resolved to nothing" (a bare `?include=`, an empty path list, answers it too), which they emit as `included: []` |

Because every resource is reached _through_ a document resource's linkage, full linkage holds by construction **for the array the resolver returns**: handed unchanged to `Handlers.data` / `Handlers.collection` with the same primary data, the builders' check is a guard over the resolver's own output rather than a live constraint. It is live again when anything between the walk and the document changes linkage, because the check runs on the resources the document actually emits:

- an `onResource` transform that removes or rewrites `relationships` — the check walks reachability from the primary data, so on the primary data it orphans every member reachable only through the primary data's linkage, on an included resource every member reachable only through it, however many hops on (`Handlers.project` and `Handlers.withMeta` leave `relationships` alone; `Handlers.transform` is unconstrained). A member other members still reference is orphaned all the same once the walk cannot reach it: a cycle of members, or a member that references itself, does not link itself to the document;
- editing the array — dropping a member can orphan everything reachable only through it, and an appended resource was never reached at all;
- building the document from different primary data than the walk started from.

So a resolver-built document is not, by itself, a reason to pass `checkLinkage: false`: keep the check on unless you know none of these applies.

Per-viewer visibility rides along for free: every hop loads through the same authorised loader, so the deepest hop of an anonymous caller's walk excludes exactly what their direct read would.

`paginated` relationships carry no inline linkage, so they contribute nothing to a walk — which is why they are excluded from `?include=` paths to begin with.

Pagination links are built with `Handlers.offsetPaginationLinks` (for `Page.Offset`) and `Handlers.numberPaginationLinks` (for `Page.Number`), which emit the spec's `first` / `prev` / `next` / `last` top-level links from the request's page parameters and the total count. Pass the request's other query parameters as `{ query: Query.canonicalPairs(listQuery)(query) }` and every link carries them too ([the canonical query string](query.md#the-canonical-query-string)).

To name the value a builder returns — e.g. on a helper that assembles documents outside a handler — use `Handlers.DocumentValue<Data, Included?, Meta?, JsonApi?>` (the runtime shape, with an optional `jsonapi` member) or the schema-derived `Document.Value<R, Included?, Meta?>`, instead of hand-rolling the `{ data, included?, links?, meta?, jsonapi? }` envelope.

To serve it (with `@effect/platform-node`):

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Middleware } from "@thomasfosterau/effect-jsonapi";
import { Layer } from "effect";
import { createServer } from "node:http";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(ArticlesLive),
  Layer.provide(Middleware.layer), // content negotiation, JSON:API 400s, a 201's `Location`
);

// Effect 4's HttpApiBuilder builds a fresh router per entrypoint: serve the API layer through
// `HttpRouter.serve` (or `toWebHandler`), not through a router you provide.
HttpRouter.serve(ApiLive).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
  Layer.launch,
  NodeRuntime.runMain,
);
```

If you negotiate content outside `HttpApi` — say in a framework hook that owns the URL — `Middleware.negotiate(headers, options?)` runs the §5 rules standalone over the request's headers (a web `Headers`, an effect `Headers` or a plain record), returning an `Option` of the offending `ApiError` (`UnsupportedMediaType` / `NotAcceptable`), and `ApiError.toDocument(error)` renders any `ApiError` to a JSON:API error-document value:

```ts
const error = Middleware.negotiate(request.headers);
if (Option.isSome(error)) {
  const body = ApiError.toDocument(error.value); // { errors: [{ status, code, title }] }
  // → respond with `Number(body.errors[0].status)` and `body`
}
```

`toDocument` takes an `ApiError.Any`, the type of every `ApiError.make` instance. A hook that caught an arbitrary value narrows it with `ApiError.isApiError` first:

```ts
const render = (caught: unknown) =>
  ApiError.isApiError(caught) ? ApiError.toDocument(caught) : undefined;
```

`Middleware.schemaError(part)` is the other half: the JSON:API **400** a request-validation failure produces, standalone. It's the same value the `SchemaErrors` middleware raises inside `HttpApi`, so a hook that decodes requests with its own schemas answers byte-identically to an `Endpoint`-built api:

```ts
const parsed = Schema.decodeUnknownExit(ListQuery)(params);
if (parsed._tag === "Failure") {
  return json(400, ApiError.toDocument(Middleware.schemaError("Query")));
}
```

### Api-wide policy: `JsonApiConfig`

Where the specification leaves a choice to the server, the middleware reads it from `JsonApiConfig`, a `Context.Reference` whose default is the behaviour described in this guide. Provide `JsonApiConfig.layer(…)` beneath `Middleware.layer` to change a policy for the whole api, instead of repeating it on each layer:

```ts
HttpApiBuilder.layer(Api).pipe(
  Layer.provide(ArticlesLive),
  Layer.provide(Middleware.layer),
  Layer.provide(
    JsonApiConfig.layer({
      extensions: [Atomic.EXTENSION_URI],
      acceptWithoutJsonApi: "serve", // answer `Accept: application/json` instead of 406
      allowedQueryParameters: ["_", "lang"],
    }),
  ),
);
```

An option passed to `Middleware.layerWith` (or `contentNegotiationLayer` / `schemaErrorsLayer`) overrides the config for that layer; a member neither sets is `JsonApiConfig.defaults`. The middleware reads the config once, when its layer is built.

`acceptWithoutJsonApi: "serve"` answers an `Accept` that names no JSON:API media type and no wildcard (`application/json`, `text/html`) with the JSON:API document, as RFC 9110 lets a server do with its only representation. An `Accept` that does name the JSON:API media type is still held to §5: if every instance carries a disallowed parameter, the answer is 406.

Policies that shape a schema, such as `maxUndeclaredMemberErrors` or page bounds, are fixed when the resource or endpoint is defined, before any layer exists, so they stay options of `Resource.make` and the `Endpoint` constructors.

### When the host already negotiated

If you _do_ adopt the endpoint constructors but your host negotiates content upstream — a framework hook serving JSON:API and HTML on one URL space — the constructors' `ContentNegotiation` middleware would run §5 a second time. That's redundant at best, and contradictory when the host deliberately admits something the spec's rules reject (an api that accepts `Accept: application/json` would see those requests 406'd after the hook let them through).

`Middleware.layerHostNegotiated` is the drop-in replacement for `Middleware.layer` in that case: it satisfies the endpoints' `ContentNegotiation` requirement without performing any checks, leaving the host the single negotiating authority, and keeps `SchemaErrors` live so request validation still answers with JSON:API 400s (and `CreatedLocation`, so a create's `201` still carries `Location`). Nothing else about the endpoints changes.

```ts
HttpApiBuilder.layer(Api).pipe(
  Layer.provide(ArticlesLive),
  Layer.provide(Middleware.layerHostNegotiated), // the hook ran `Middleware.negotiate` already
);
```

Use it only when something upstream genuinely enforces §5 — for an api that owns its own URLs, `Middleware.layer` remains the correct choice. (`Middleware.ContentNegotiationPassthrough` is the negotiation half alone, for composing your own set.)

### Reserved query parameters

The `SchemaErrors` middleware rejects, with a 400 per offending parameter, every query parameter whose family base name is made only of a-z and that the endpoint's `query` schema doesn't declare — the spec's MUST, which reserves those names so it can standardise more later. That includes the specification's own families on an endpoint that doesn't support them ([Query parameters](query.md)), each with its own detail. The same MUST covers a parameter that "does not follow the naming conventions": one whose base name is not a legal member name (`?foo!=1`, `?page.limit=1`, `?[x]=1`) and one named for an extension (`?ext:param=1`, the namespace, a colon and a-z), which the server processes only when it supports that extension's parameters — none of this package's extensions defines any. Only an implementation-specific name, a legal member name carrying a character outside a-z (`?fooBar=1`, `?x-trace=1`, `?utm_source=`), is ignored. A host whose URL space carries such parameters through to the api (`?lang=`, `?ref=`) can either rename them (`langCode`, `x-ref` — the spec's recommendation) or list them, by family base name:

```ts
Layer.provide(Middleware.layerWith({ allowedQueryParameters: ["_", "lang"] }));

// or, when the host negotiates content itself:
Layer.provide(
  Layer.mergeAll(
    Middleware.ContentNegotiationPassthrough,
    Middleware.schemaErrorsLayer({ allowedQueryParameters: ["_", "lang"] }),
    Middleware.CreatedLocationLive, // the create's `Location` header
  ),
);
```

The allow-list defaults to `["_"]`, so jQuery's cache-buster (`$.ajax({ cache: false })` appends `?_=<timestamp>`) keeps working; a list you pass replaces the default, so list `"_"` too to keep it, or pass `[]` to answer it 400 as well. An extension's parameter is listed the same way (`"ext:param"`), as is any other name that is not a legal member name (`"foo!"`).

Each entry must be a base name the check would otherwise reject: `lang[region]`, `Lang`, `x-trace`, `page%5Bsize%5D`, `[x]` or `""` throws `Middleware.InvalidAllowedQueryParameter` when the layer is built, rather than silently admitting nothing (list a bracketed member by its base name, and a name as it decodes; an implementation-specific name is never rejected, so it needs no entry; a name with an empty base name, starting `[`, cannot be admitted). So does a family the specification defines — `include`, `fields`, `sort`, `page` or `filter` — and any bracketed name of one, such as `page[size]`: an endpoint supports a family, or a `fields`, `page` or `filter` member, by declaring it in its `query` schema, and answers 400 when it doesn't, under the specification's general rule (§Implementation-Specific Query Parameters: if "the server does not know how to process it as a query parameter from this specification, it **MUST** return `400 Bad Request`"; see [Query parameters](query.md)). JSON:API defines only the bare `include` and `sort`, so the refusal of an `include[]` or `sort[title]` entry says so; one of a name that only starts like a family's (`page[`, `page[size`, `filter[_]`) says it is no member of the family. The allow-list can't switch that 400 off, so a spec family is never silently ignored.

An allowed name never reaches the endpoint's decoded `query`, which keeps only what its `query` schema declares — also when that schema declares nothing; it is only no longer rejected. `Middleware.checkQueryParameters(names, { declared, allowedQueryParameters })` is the same check standalone, for a hook that decodes requests itself: it returns an `Option` of the 400 document.

And to call it — the same definitions drive a fully typed client:

```ts
import { Client } from "@thomasfosterau/effect-jsonapi"
import { Effect } from "effect"

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

## The per-resource transform pass (`onResource`)

A document carries the same resource type in more than one slot: primary `data`, every `included` member, the identifiers of a relationship document. Per-resource processing that only reaches one of them — a sparse fieldset projected out of `data` but not out of `included`, per-viewer `meta` stamped on one but not the other — leaves a document describing one type two different ways. Sparse fieldsets in particular are specified to apply to **every** resource of that type in the document.

`onResource` is one pass over all of them:

```ts
Handlers.data(article, {
  included,
  self: `/articles/${article.id}`,
  onResource: Handlers.compose(
    Handlers.project(query.fields), // ?fields[articles]=title
    Handlers.withMeta((r) => Option.some(permissions(viewer, r))), // { canEdit, canDelete }
  ),
});
```

It runs **once per resource** — after `included` is deduplicated (so once per distinct resource, not once per occurrence) and before the full-linkage check (so the check sees what the document actually emits). A resource reached in two slots is shaped once and that result reused, so it cannot come out two ways. Transforms must therefore be pure functions of the resource, and must not change its `type` or `id`.

The same option is on `Handlers.collection`, on `Handlers.linkage` (where it reaches the resource identifiers §8.4 makes a relationship document's primary data), and on `Handlers.buildIncluded`.

| Transform | What it does |
| --- | --- |
| `Handlers.project(fields)` | Sparse fieldsets: narrows `attributes` and `relationships` to the names requested for the resource's type. |
| `Handlers.withMeta(compute)` | Merges computed `meta` over the resource's own; `compute` returns an `Option`, `Option.none()` for a resource it has nothing to say about. |
| `Handlers.compose(first, second)` | One pass doing both. |
| `Handlers.transform<Lambda>(f)` | Anything else, with its type-level effect declared. |

`Middleware.layer` applies the same projection to the encoded 2xx document of every endpoint it serves, so a handler that skips `Handlers.project` still answers to §Sparse Fieldsets; projecting in the handler saves the middleware's rewrite and lets a handler avoid loading what it would drop. `sparseFieldsets` on `JsonApiConfig.layer`, or on `Middleware.layerWith` (or `schemaErrorsLayer`), chooses: `"project"` (the default), `"verify"`, which answers a document carrying an excluded field with the opaque JSON:API 500, or `"handler"`, which leaves fieldsets to the handler unchecked.

`Handlers.project` also has a data-first form, `Handlers.project(resource, fields)`, for projecting one resource directly. Two behaviours make it safe to run over a whole document: a type with **no requested set** (`fields[TYPE]` absent) is returned unchanged, every field it carries, and only fields are projected — `attributes` and `relationships`, which JSON:API counts as a resource's fields together ([§Fields](https://jsonapi.org/format/1.1/#document-resource-object-fields)) — so the resource's own `links` and `meta` survive and a resource identifier passes through untouched. A relationship the set does not name is dropped whole, its `links` and `meta` with its `data`, and a `relationships` member left empty is omitted: `?fields[articles]=title,author` keeps `author` and drops every other relationship. A requested **empty** set (`?fields[TYPE]=`, which `Query.schema` decodes as `[]`, not as the absent parameter) is not "every field": §Sparse Fieldsets says "An empty value indicates that no fields should be returned", so it projects `attributes` to `{}` and drops every relationship.

Dropping a relationship can unlink the `included` members only it reached: `?include=author&fields[articles]=title` answers the author while the article no longer links to it. [§Compound Documents](https://jsonapi.org/format/1.1/#document-compound-documents) exempts exactly that case — "when relationship fields that would otherwise contain linkage data are excluded due to sparse fieldsets" — and so do the checks. The transform `Handlers.project(fields)` builds carries its fieldset (through `Handlers.compose` too), and the builders' full-linkage check follows the linkage of each relationship that fieldset excluded as the resource carried it before the transform, so a member reached only through one passes and a member nothing links still throws; `Handlers.buildIncluded` reads its `primary` as passed. `Middleware.SchemaErrorsLive` reads `fields[TYPE]` from the request: the encoded document cannot show what an excluded relationship linked, so once its walk reaches a resource of a type the request names a fieldset for, it reports no member. `Assemble.relationship` checks full linkage from its identifiers the same way `Handlers.linkage` does, exemption included.

### Sparse fieldsets and the default document

An endpoint that declares `fields` binds, by default, a document whose resource objects admit **any subset of their fields** — attributes and relationships alike: the primary data and every `included` member of a type a `fields[TYPE]` can name — the resource, its non-`paginated` direct targets (unless `include` is a declared `Include.Surface`) and every type a legal include path reaches, the set `Query.FieldsetResources` computes. A family in `data` or `included` stands for its members (recursively, for a family nested in another), each made partial under its own type. Every attribute and every relationship becomes an optional key; one that is already optional stays as declared, and `type`, `id`, `links` and `meta` are untouched. That is what lets a handler answer with `Handlers.project(query.fields)` with no cast, and what lets the answer to `?fields[articles]=title` omit `body`, as §Sparse Fieldsets requires ("an endpoint **MUST NOT** include additional [fields]"). It holds for `get`, `list`, `related`, `collection` and `polymorphic` — and for `getRelationship`'s `included` members, its primary data being identifiers ([compound relationship documents](endpoints.md#compound-relationship-documents)) — and for the `get`, `list` and related endpoints `Endpoint.resource` / `Group.resource` generate, which declare `fields` by default. An endpoint without `fields` keeps exactly the document it had.

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

**What a client sees.** An endpoint has one success schema, which is both what the handler encodes and what `HttpApiClient` decodes into, so on an endpoint declaring `fields` the client reads those attributes and relationships as optional: `doc.data.attributes.title` is `string | undefined`, whether or not the request asked for a fieldset. A complete resource decodes as before; a projected one decodes instead of failing.

**Keeping strict attributes.** When every caller wants every attribute, leave `fields` off: `fields: false`, which `Group.resource` / `Endpoint.resource` take at the top level or per endpoint. The endpoint then binds the strict document it would have without `fields`, and `?fields[TYPE]=` is a 400 rather than an answer the client cannot trim.

Keeping `fields` and passing a strict `success` also works, at two costs. First, the handler must not project, so a request for a fieldset is answered with every attribute, including those the client excluded. Second, `success` replaces the whole default document, and `Article.document()` (`Article.collection()` for `list`) equals the strict default only while `include` is off and the endpoint's `meta` is not overridden. With `include` on, which is the `Group.resource` default, its `included` admits only `Article`'s direct targets, not every type an include path reaches, and an endpoint `meta` option no longer applies. The override must then reproduce both: `Article.document({ included: Include.included(Article, { include }), meta })`, whose `included` admits every type `Article`'s include paths reach (see [Overriding the success document](endpoints.md#overriding-the-success-document)).

`Handlers.withMeta` merges the computed members over whatever `meta` the resource already carries, and emits **no** `meta` member when the merged result is empty: to the spec an empty `meta` object is a present-but-empty meta, which says something different from saying nothing.

### The effect stays in the type

The builders' return type is computed from the transform rather than widened:

```ts
const document = Handlers.data(article, {
  included: [otherArticle],
  onResource: Handlers.project({ articles: ["title"] }),
});

document.data.attributes; // { title: string } — `body` is gone
document.included?.[0]?.attributes; // { title: string } — and gone here too, identically
document.data.relationships; // a type error: no relationship was requested, so there is none
```

A fieldset known only at runtime (`query.fields`) can be any subset of the selectable names, so each projected attribute and relationship is typed as optional — honest in both directions rather than claiming a selection the request may not have made.

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

One consequence is worth stating plainly: a projected document is deliberately _not_ the endpoint's default response-document type. A resource with attributes removed no longer satisfies a schema that requires them, and the type says so rather than pretending otherwise. On an endpoint that declares `fields` the default document admits the projection (see [Sparse fieldsets and the default document](#sparse-fieldsets-and-the-default-document)); any other endpoint that projects needs a success document that does — see [Overriding the success document](endpoints.md#overriding-the-success-document) — built over a resource variant whose attributes are optional.
