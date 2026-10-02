# @thomasfosterau/effect-jsonapi

## 0.16.3

### Patch Changes

- 24b078b: Tested against `effect` 4.0.0; the peer floor (`>=4.0.0-rc.118`) is unchanged. `Resource.Id` and `Resource.extend`'s `inheritId` now pass an explicit type argument to `Schema.brand`, which 4.0.0 requires of a generic brand identifier. The public types are identical.
  
  On effect 4.0.0, `Schema.brand` is type-only, so `Id` schemas no longer carry an `ast.annotations.brands` entry and `SchemaRepresentation` code output omits the brand; OpenAPI and JSON Schema output are unchanged.

## 0.16.2

### Patch Changes

- 5c5952c: Doc comments: the package-root module doc no longer cites `@effect/platform` or carries a sample that does not compile, and the off-vocabulary `@category` tags (`catalogue`, `readers`, `utilities`, `predicates`, `mapping`, `encoding`) now use the documented vocabulary (`errors`, `accessors`, `utils`, `guards`), so the generated API docs group them with their peers.

## 0.16.1

### Patch Changes

- e698ed0: Correct the 0.16.0 notes on two rc.118 consequences, and tighten the `/schema` entry-point guards. No runtime change.
  
  - `FlatQuery.slug`'s length check is now `Schema.isBetweenLength`, so its runtime annotation `ast.checks[0].annotations.representation.id` reads `effect/schema/isBetweenLength` where it read `effect/schema/isLengthBetween`. This reaches beyond stored `SchemaRepresentation` documents (regenerate those): any consumer keying on `annotations.representation.id`, such as effect-forms' `constraintsFromSchema`, which maps the old id to HTML `minlength` / `maxlength`, must update, or slug fields silently lose those attributes. Accepted values and messages are unchanged.
  - Effect rc.118 builds a fresh `HttpRouter` per entrypoint, so routes added to a router you provided yourself are not served. Serve `Registry.layer` / `HttpApiBuilder.layer` through `HttpRouter.serve` or `HttpRouter.toWebHandler`, not through a self-provided `HttpRouter.layer`. The README server snippet now shows this.

## 0.16.0

### Minor Changes

- b163104: **Breaking:** require `effect@>=4.0.0-rc.118` (was `>=4.0.0-rc.113`) and build against `4.0.0-rc.118`.
  
  Effect rc.118 removed every `effect/unstable/*` import path with no compatibility export: `effect/unstable/http` is now `effect/http`, `effect/unstable/httpapi` is now `effect/http-api`, and the published declarations import the new paths. No earlier `effect` release resolves them, so the peer floor moves with the paths. A consumer on rc.117 or below must upgrade `effect` and every `@effect/*` companion to rc.118 together, and must resolve a single `effect` copy.
  
  The public API of this package is unchanged: every export, signature and wire behaviour is the same, and `Middleware`, `ServerErrors`, `Registry`, `Negotiation`, `Query`, `Assemble` and `Group` keep their shapes. What rc.118 forced:
  
  - Import paths in the emitted `.d.ts` and `.js` (`effect/http`, `effect/http-api`), as above.
  - `Schema.isLengthBetween` was renamed `Schema.isBetweenLength` in rc.118. `FlatQuery.slug` uses the new name; its accepted values and messages are unchanged, but the internal check identifier a `SchemaRepresentation` or JSON Schema document records for the length check is now the rc.118 one, so regenerate any stored representation of a `slug` schema.
  - Effect's own `HttpApi` type identifiers and service keys now read `http-api` rather than `httpapi`. Code that matches those strings, such as a snapshot or an SSE client keyed on the reserved failure event name, needs the new spelling. This package matches none of them.
  - `/schema` still resolves `effect` alone. Its entry-point tests now assert that it reaches none of Effect's HTTP surface (`effect/http`, `effect/http-api`) rather than the removed `effect/unstable/*` namespace.

## 0.15.2

### Patch Changes

- 07f9c1a: `ServerErrors.schemaIssueToErrors` now uses a struct-level check's `message` annotation as the `detail` for each field the check points its failure at. Before, those fields' `detail` read `Expected a valid value`. For example, a `makeFilter(..., { message: "Passwords must match" })` on a struct that returns `{ path: ["confirm"], issue: new SchemaIssue.InvalidValue(undefined) }`, or an array of such issues, now gives `Passwords must match` at `/data/attributes/confirm`, which matches what Effect's own formatter renders. A pointed issue that carries its own `message` keeps it. `status`, `code`, `source.pointer` and the error count are unchanged.

## 0.15.1

### Patch Changes

- ccf9b8c: Render a schema issue's `detail` with Effect's own formatter. Until now `ServerErrors.schemaIssueToErrors` built it with `String(issue)`, which prints `[object Object]` because Effect Schema issue nodes have no `toString`.
  
  Each error object's `detail` is now Effect's default formatter output (`SchemaIssue.makeFormatterDefault()`), for example `Missing key`, `Expected number` or `Expected "a" | "b"`. A failed check takes its message from the check itself, either its `expected` text (for example `Expected a value with a length of at least 3`) or its `message` annotation. The same formatting applies when a schema issue is passed as one of `ValidationFailure`'s issues. Every other part of each error object is unchanged: `status`, `code`, `source.pointer` and the error count.

## 0.15.0

### Minor Changes

- 78657c9: Raise the Effect peer dependency floor from `>=4.0.0-beta.104` to `>=4.0.0-rc.113`. This is a breaking change for consumers resolving Effect below the new floor, which was necessary because semver sorts `rc` versions above `beta` versions. The previous range allowed applications to land on a version that sibling libraries (effect-auth, legation) cannot co-install with.
- cbb1636: Add `Include` — declare a resource's `?include=` surface once
  
  Serving compound documents needs three things to agree: the whitelist of accepted dotted paths, the `included` union the success schema declares (`HttpApiBuilder` strips a resolved `included` the schema doesn't admit), and the advertised `include` parameter. Until now those were separate declarations over separate inputs, so they could drift.
  
  `Include.make(resource, spec)` is one nested declaration all three project from:
  
  ```ts
  const surface = Include.make(Article, {
    author: Person,
    comments: Include.nested(Comment, { author: Person }),
  });
  
  surface.paths; // ["author", "comments", "comments.author"] — typed literals
  surface.included; // Schema.Union([Person, Comment])
  surface.has("comments.editor"); // false — the whole dotted path is matched
  
  Endpoint.get(Article, { include: surface }); // all three, from the one declaration
  ```
  
  - The whitelist spells depth: `comments` being includable does not admit `comments.editor`.
  - Nesting only ever _adds_ paths — `?include=comments` keeps meaning what it did.
  - The union carries every depth, deduplicated by schema identity, so a walk that hoists a Comment and the Person behind it has both arms.
  - Every key is checked against the resource's relationship graph (unknown key, `paginated` relationship, or wrong target) at compile time and again when the surface is built.
  
  A surface is accepted wherever `include` is — `Endpoint.get` / `list` / `related`, `Query.schema`, `Query.Include` and `Group.resource` (top-level and per endpoint) — and on `get` / `list` / `related` it also derives the success document's `included` union.
  
  Because the derivation recurses over the declaration rather than the relationship graph, a declared surface is not bound by the depth-2 ceiling `include: true` inherits; it is capped explicitly at `Include.MAX_DEPTH` (6) hops, where the type-level derivation truncates and `Include.make` throws.
  
  `Include.paths(spec)` and `Include.included(spec)` are the same two projections standalone. `include: true` and `Query.IncludeOptions` are unchanged for consumers who don't opt in.
  
  The module is schema-tier, so it is exported from `@thomasfosterau/effect-jsonapi/schema` as well as the package root: it derives the whitelist and the union from resource definitions alone, without resolving `effect/unstable/httpapi`.
  
  Mutually-recursive resources are fully supported. The derivation recurses over the declaration you wrote, never over the resource graph, so an `Article` ⇄ `Comment` cycle costs it nothing and the `included` union terminates by construction.
  
  The declared surface feeds the runtime half with no glue: `surface.paths` is the `includable` whitelist `Query.validateIncludePaths` checks a request against, and the same array is the `paths` argument to `Handlers.resolveIncluded`.
- d1ad58f: **An Effect-native compound-document `include` resolver: `Handlers.resolveIncluded`.** Walking the requested `?include=` paths — reading refs off relationship linkage, loading them, doing it again for the next hop, deduplicating across paths and rows, dropping refs that don't resolve — was left entirely to the consumer, and it is the same algorithm for every JSON:API server. It is now one call (#106):
  
  ```ts
  // One loader per resource type, called once per level with every id that level
  // collected — so each is a single `WHERE id IN (…)`, never a lookup per row.
  const targets = {
    people: (ids: ReadonlyArray<string>) => db.people.byIds(ids),
    comments: (ids: ReadonlyArray<string>) => db.comments.byIds(ids),
  };
  
  handlers.handle("list", ({ query }) =>
    listArticles(query).pipe(
      Effect.flatMap(({ items, total }) =>
        Handlers.resolveIncluded(items, query.include, targets).pipe(
          Effect.map((included) => Handlers.collection(items, { included, meta: { total } })),
        ),
      ),
    ),
  );
  ```
  
  It is a plain `Effect` a handler composes — no service to provide, no runtime to set up — and the same call serves one primary resource, a page of them, or `null`.
  
  - **Batched per level, across the whole primary set.** Every parent's references for the current segment are collected and deduplicated before anything is loaded, then handed to the loaders as one batch per distinct type. `?include=author.employer` over a 50-article page is two loader calls, not a hundred.
  - **One bucket keyed `(type, id)`.** Two paths or two rows reaching the same resource contribute it once; a shared path prefix costs no second query; a resource already in the primary `data` is never duplicated into `included`. Emission follows walk order, so a `get`'s `included` and a `list`'s agree.
  - **Depth-capped and cycle-safe.** A cyclic graph (`articles → comments → articles`) revisits resources the document already holds, which are never re-loaded; `depth` (default `3`, the deepest path `Query.Include` legalises) bounds the hops, since §7.1 leaves the bound implementation-defined and an unbounded walk is a denial-of-service surface. `concurrency` bounds a level's fan-out.
  - **An unresolvable ref is dropped, not a failure** — an unknown target type, an id the batch didn't return, a row the viewer may not see — while a genuine loader fault propagates and fails the document. `undefined` (not `[]`) when nothing was requested, so the caller omits the member.
  
  Because every resource is reached _through_ a document resource's linkage, full linkage holds by construction and `Handlers.buildIncluded`'s check becomes a guard rather than a live constraint.
  
  New exports: `Handlers.resolveIncluded`, `Handlers.IncludeTarget`, `Handlers.IncludeTargets`, `Handlers.ResolveIncludedOptions`, and the type-level `Handlers.IncludeTargetResource` / `IncludeTargetError` / `IncludeTargetServices` for naming a registry's projections. Nothing existing changes.
- 0bb9962: The client-side helpers three consuming applications each re-implemented in their web app's api layer, as an extension of `Client`:
  
  - **Decoded error responses** — `Client.make(api, { decodeErrors: true })` fails every call the server answered with an error response as a `Client.ErrorResponse` (its status, a readable message, the JSON:API error document when the body carried one) instead of the raw `HttpClientError`; transport faults pass through unchanged. `Client.failWithErrorResponse` is the same seam standalone, `Client.toErrorResponse` the reader behind it, `Client.isErrorResponse` the guard.
  - **Document readers** — `Client.ResourceDocument<R>` / `Client.CollectionDocument<R>` (the wire form, `Document.Wire`), `Client.readTotalCount` and `Client.hasNextPage` (correct at an exact multiple of the page size).
  - **Call-site inputs** — `Client.LooseInput<T>`, `Client.stripUndefined` and `Client.decodeInput(schema)`, which strips explicitly-`undefined` members before decoding a flat list or command input with its defaults and bounds.
  - **`included` hydration, typed by the resource definition** — `Client.indexIncluded` (once per document), `Client.related(resource, data, key, index)` (an `Option` of the target for a to-one relationship, an array in linkage order for a to-many; an unresolved ref is skipped, never a failure), `Client.walk(resource, data, "authors.contributor", index)` (a dotted path hop by hop to the last hop's resources, deduplicated) and `Client.hydrate(resource, document)` binding both to one document.
  - **Page cursors** — `Client.readPageCursor` (`page[offset]` / `page[limit]` off a URL, search params or query string, per-field fallbacks, the limit clamped, a custom key for a page with two lists), `Client.pageHref` (replace the cursor, keep everything else), `Client.filteredPageHref` / `Client.windowedPageHref` (the two `href(offset)` builders index pages use), `Client.canonicalPageHref` (the cursor spliced into `Query.canonicalPairs` output, the spelling a server's collection links use) and `Client.pageWindow` (the page-link window arithmetic behind a pagination control).
- d066d53: Declare `sideEffects: false` in package.json for better bundler tree-shaking. Remove `src/` from published files — the package now only ships `dist/`, `README.md`, and `LICENSE`, matching the structure of sibling libraries. Disable declaration maps and source maps in `tsconfig.json` to avoid references to unpublished source files.
- 00007c2: Build against Effect `4.0.0-rc.113` and later, and raise the published `effect` peer floor to `>=4.0.0-rc.113`.
  
  Effect `4.0.0-rc.113` renamed `SchemaTransformation.transformOrFail` to `SchemaTransformation.transformEffect`. The options are unchanged. The filter grammar (`Query.Filter`), the combined query schema's `filter[...]` routing (`Query.schema`) and the filter-literal codecs now call `transformEffect`. Decoding, encoding and error output do not change. Before this, every `effect` release from `rc.113` up was inside the declared range but failed to compile.
  
  No Effect release has both names, so one range cannot cover `rc.112` and `rc.113+`. This release therefore publishes `>=4.0.0-rc.113`, still open at the top as the shared Effect-floor policy requires. **This is breaking for consumers on `effect@4.0.0-rc.112`**: move Effect to `rc.113` or later, or stay on `effect-jsonapi@0.14.x`.
- 4b443ef: **`Handlers.data` / `Handlers.collection` / `Handlers.linkage` accept a `jsonapi` option.**
  
  `Handlers.DocumentValue` declared an optional top-level `jsonapi?: JsonApiObjectValue` member, but no builder accepted or emitted it — the type promised a member the implementation could never produce, so the only way to attach the top-level `jsonapi` object to a built document was a cast (#103).
  
  ```ts
  Handlers.data(article, { jsonapi: Document.v1_1, self: `/articles/${article.id}` });
  Handlers.collection(items, { jsonapi: Document.v1_1, links, meta });
  ```
  
  `data` / `collection` / `linkage` now each take a `jsonapi` option and stamp it onto the built document, with the return type narrowing on whether the option was passed: `jsonapi` is present (and required, not merely optional) when you pass one, and absent from the type entirely when you don't — reading `.jsonapi` back off the result needs no cast in either direction. This follows the same conditional-generic pattern the builders already use for `included` and `meta`, adding a fourth type parameter (`J extends JsonApiObjectValue = never`) to `DocumentValue` — an additive change to a type most callers only accept from a builder's return value, not one they parameterize by hand.
  
  **Not emitted by default.** A JSON:API 1.1 server arguably should advertise the version it implements on every document, but defaulting it here would silently add a `jsonapi` member to every response body every existing caller of `Handlers.data` / `Handlers.collection` / `Handlers.linkage` already produces — a behavioural change riding along on a bug fix, not something a type/implementation mismatch fix should decide on a consumer's behalf. Advertising the version stays opt-in: pass `jsonapi: Document.v1_1` (or `Atomic.jsonapi` under the atomic-operations extension) on the responses where you want it.
- 78634c7: Publish the legal vocabulary on the 400 for a rejected `?include=` path or `?sort=` field, and ship the adoption guide for the 0.14 surfaces.
  
  A request naming an include path outside the endpoint's declared surface (or a sort field outside its sortable set) was already answered with a spec-compliant 400 whose `source.parameter` named the offending key — but not with what the endpoint _does_ accept, so a caller that guessed wrong had to guess again. The include and sort literal schemas now carry that set as error `meta`, and `Middleware.schemaErrorDocument` copies it onto the error object: `meta.includablePaths` (the same set `ApiError.UnsupportedIncludePath` publishes) and `meta.sortableFields`. Error objects for schemas that publish nothing are unchanged — no `meta` member appears.
  
  `docs/guides/adopting-0.14.md` walks an existing consumer from its own include spec, include walk, fieldset projection, error-document decoder and Accept parser to `Include.make`, `Handlers.resolveIncluded`, `Handlers.compose(project, withMeta)`, `Client.errorDocument` and `Middleware.negotiate`, with before/after code taken from a consuming application; every "after" snippet is executed by `test/guides/adopting-0.14.test.ts`.
- 24550e8: `ApiError.make` can declare a `source` (constant, or a function of the fields for a per-instance `pointer`/`parameter`/`header`), so field-scoped validation errors like "this slug is taken" can carry `source.pointer` without hand-building a document. Added `Document.pointer` (RFC 6901 constructors for attribute/relationship pointers, with a collection-payload `index` and an `escape` helper) and `Document.parsePointer` (the inverse: parses a pointer back to the member it names, `None` for non-member and empty-segment pointers). `Middleware`'s internal JSON Pointer builder now reuses `Document.pointer.escape` instead of its own copy of the RFC 6901 escaping.
- c66f143: Add `Document.href`, an accessor that narrows a `Link` (`string | URL | LinkObject`, undefined-safe) to its wire string. Every link on a resource derived from `Resource.make` decodes to this union so that relative URI-references (which `URL` cannot represent) still parse absolute ones to a real `URL`; reading a link as a plain string previously meant re-deriving this narrowing per project. `Document.href` does it once: `Document.href(resource.links?.self)` — no resource redeclaration needed to get the string a wire response actually carries.
  
  The permissive `Document.Url` / `Document.Link` union is unchanged and stays the default — this is purely additive, so nothing that decodes or encodes links today changes behavior.
- 131e894: **Tracing: `Effect.withSpan` on content negotiation and request-validation failures (#122).** A traced request used to go dark exactly where this package does its work. The two places `src/` actually runs an `Effect` per request — JSON:API §5 content negotiation and the translation of a request-validation failure into a JSON:API 400 document — now wrap that work in a span, under stable names collected in `Middleware.Span`:
  
  ```ts
  import { Middleware } from "@thomasfosterau/effect-jsonapi";
  
  Middleware.Span.negotiate; // "effect-jsonapi.negotiate"
  Middleware.Span.schemaError; // "effect-jsonapi.schema_error"
  ```
  
  - `Span.negotiate` — one span per request, tagged `jsonapi.negotiation.outcome` (`"accepted"` / `"rejected"`) and, only when rejected, `jsonapi.negotiation.rule` (`"content_type"` / `"accept"`).
  - `Span.schemaError` — one span per request-validation failure, tagged `jsonapi.request_part` with the `Middleware.RequestPart` that failed (`"Params"`, `"Headers"`, `"Query"`, `"Body"`, `"Payload"`).
  
  Both are attached automatically by `ContentNegotiationLive` and `SchemaErrorsLive` — no new layer or configuration is needed, and `Effect.withSpan` is a no-op when no `Tracer` is in context, so a host with no tracing set up sees no behavior or performance change. Every attribute value is one of a small fixed set of strings; none of them is a header value, a filter literal, a query string, or anything else that varies per request or could identify a user.
  
  The rest of the package — query/filter/sort decoding, document assembly, atomic-operation processing — has no `Effect` of its own to attach a span to today (decoding and encoding run inside `HttpApi`'s own schema machinery; the document builders in `Handlers.ts` are synchronous helpers). Instrumenting those meaningfully needs an API change beyond this issue's scope; see the discussion on #122 for the proposed follow-up.
- 9b45e17: Add a client-side surface to `Client`: content negotiation and best-effort error-document decoding.
  
  A client derived by `HttpApiClient.make` sends no `Accept` header, and no `Content-Type` on a bodyless mutation such as `DELETE` — so it does not meet JSON:API's client responsibilities, and a host serving HTML and JSON:API on one origin has nothing to select on. Turning a failed call into the error document it carries was left to the consumer too. Both are now the package's.
  
  **Negotiation**
  
  - `Client.make(api, options)` — `HttpApiClient.make` with the JSON:API request transform pre-applied. The common case needs no `transformClient`, and an api using extensions takes the same `extensions` value as the server's `Middleware.layerWith`.
  - `Client.transform` / `Client.transformWith(options)` — the same transform over an existing `HttpClient`, for a custom transport or `HttpApiClient.makeWith`.
  - `Client.jsonApiHeaders` / `Client.jsonApiHeadersWith(options)` — the transform over one request: `Accept` on every request, `Content-Type` on every mutating one. Only the label changes: the body bytes are untouched, and a request that already declares a genuinely different representation (`multipart/form-data`) keeps its `Content-Type`.
  - `Client.isMutatingMethod(method)` — the `POST` / `PATCH` / `PUT` / `DELETE` predicate, exported because it is a correctness detail rather than sugar: a bodyless `DELETE` still carries the label, and a façade and a server that both call this cannot disagree about which requests do.
  - `Client.mediaType(options)` — the media type with its `ext` parameter, built from the same definition the server's response annotations and §5 parser use, so client and server cannot drift.
  
  **Error documents**
  
  - `Client.decodeErrorDocument(body)` — a supported entry point, not an implementation detail: it takes a body rather than a response, so a façade that synthesises responses locally and never holds an `HttpClientError` decodes through the same seam as the network transport. Genuinely best-effort — HTML from a proxy, a truncated payload, an opaque 502, an empty body all yield `Option.none()` rather than throwing a second error inside the error path.
  - `Client.errorDocument(cause)` — the same decode reached from a failed call's `HttpClientError`. Never fails, never throws.
  - `Client.errorMessage(document)` / `Client.DEFAULT_ERROR_MESSAGE` — the first `detail`, else `title`, else a constant.
  - `Client.ErrorDocument` — the decoded document type.
  
  **`Client` moves to the HTTP tier**
  
  `Client.make` and the negotiation transform reach `HttpApiClient` and `HttpClient`, so `Client` now resolves `effect/unstable/httpapi` and is no longer re-exported from the schema-only `@thomasfosterau/effect-jsonapi/schema` entry point. It is unchanged on the package root. The two members that would still fit that tier — `narrowIncluded`, a type-level operation with no runtime, and `decodeErrorDocument`, which decodes through `Document`'s error schemas alone — go with it, because a namespace exported from both entry points has to be the same module object.
  
  A worked client is included as `examples/blog/client.ts`, round-tripping documents and errors against the blog example server.
- c27ad13: Resource metadata and introspection, so a third party can derive from a resource definition without reverse-engineering it.
  
  **`Resource.annotate` / `Resource.annotations`.** A resource definition is a `Schema.Struct` with its derived members assigned onto it, so Effect's own `resource.annotate({ ... })` rebuilt the schema and returned a plain struct with `type`, `identifier`, `relationships`, `declaredAttributes`, `createPayload`, `document()` and the rest gone — it was no longer a resource, and no longer a valid relationship target. `Resource.annotate(resource, annotations)` is the supported seam: it returns a complete resource of the same type, valid as a `Relationship.one(() => …)` target, with the annotations readable through `Resource.annotations(resource)`. Annotations are inherited by `Resource.extend` (the child's own keys winning) and can be declared up front with the new `annotations` option of `Resource.make` and `Resource.extend`.
  
  **`Resource.attributeDescriptors`.** The per-attribute shape a resource declares, in declaration order, as plain data: `key`, `schema`, presence in the resource object and both write projections, `clearable`, `nullable`, `readOnly` and the attribute's annotation bag. Consumers no longer need `resource.fields.attributes.ast`, a cast through `unknown`, or a decoder run against sentinel values to learn what the declaration already said.
  
  **`Relationship.paginated(ref, { order })`.** A paginated relationship can now declare its canonical order — a list of `Sort.Term`s over the related resource's attributes or its `id`. Paging is only well defined over a stable total order (`first` / `prev` / `next` / `last` denote a sequence of pages, and a cursor is a position in an order), so this is part of the relationship's wire contract rather than a storage detail, and it gets a first-class slot instead of an annotation. Storage vocabulary — a foreign-key column, a table name — has no wire representation and stays an annotation.
  
  Also: `Sort.Term` is now public (the `{ field, direction }` shape `Query.Sort` decodes into), and `Resource.Any` declares `declaredAttributes`, so `Resource.declaredAttributes` no longer reads it through a cast.
- d13d8fa: Make `asJsonApi` and `asMediaType` public via new `MediaType` namespace module
  
  Expose media type annotation combinators as a public `MediaType` module for developers writing hand-rolled endpoints with `HttpApiEndpoint`. Previously only available as `@internal` functions, `asJsonApi` marks schemas as JSON:API bodies and `asMediaType` marks them with arbitrary media types — the same annotations the package's own `Endpoint` constructors use internally.
  
  The `asJsonApiAtomic` combinator remains internal as it is specialized to the atomic operations extension.
- 13390ca: **Every comma-separated query family now accepts the repeated-key spelling, not just `include`.** (#102)
  
  `Query.schema`'s `sort` and `fields[TYPE]` options applied `Repeatable` (the codec that accepts `UrlParams.toRecord`'s array shape for a repeated key) at `include` only — `?sort=-createdAt,title` decoded, but the equivalent `?sort=-createdAt&sort=title` was a 400, with no principle distinguishing the two spellings of the same grammar. Both now decode identically, in any mix:
  
  ```ts
  // all three decode to the same sort list
  "?sort=-createdAt,title";
  "?sort=-createdAt&sort=title";
  "?sort=-createdAt&sort=title,body"; // the mixed form
  ```
  
  The same fix reaches `fields[TYPE]` and, at its list-valued positions (the shorthand `filter[f]`, `filter[f][op]`, and a group form condition's `[value]` member), the `filter` grammar (`docs/filter-grammar.md` §2) — `filter[status]=open&filter[status]=done` now decodes the same as `filter[status]=open,done`. A repeated key everywhere else in the filter grammar (a group's `[conjunction]`, any `[memberOf]`, a condition's `[path]` / `[operator]`) is still a 400: those positions take exactly one scalar. Encoding is unchanged — always the single canonical comma form.
  
  The standalone constructors — `Query.Include`, `Query.Fieldset`, `Query.Sort` — compose the same `Repeatable` widening under their item codec, so a consumer building a query from those pieces directly (rather than through `Query.schema`) gets the same repeated-key acceptance.
  
  **Behaviour change: an empty comma segment is now dropped, not rejected.** `?include=a,,b` and `?include=a,b,` (a double comma, or a leading/trailing one) previously reached the item schema as an empty-string element and failed with an unhelpful "not a valid item name" — the grammar has no way to spell an intentional empty item, so a gap is a stray separator, not a member of the set. Both now decode as `["a", "b"]`; this applies to `include`, `fields[TYPE]` and `sort` alike.
- e0e0618: Add a schema-only entry point: `@thomasfosterau/effect-jsonapi/schema`
  
  The package had a single `"."` export, so every consumer reached every module through one barrel that imports `effect/unstable/httpapi`. A client decoding documents, or a consumer mapping them into something else, resolved the whole server surface to get at schemas that never needed it.
  
  `@thomasfosterau/effect-jsonapi/schema` re-exports the modules whose import graph is `effect` alone — `Client`, `Document`, `Filter`, `Relationship`, `Resource`, `Sort` and `MEDIA_TYPE`:
  
  ```ts
  import { Document, Resource } from "@thomasfosterau/effect-jsonapi/schema";
  ```
  
  Error _documents_ are still reachable, since `Document.ErrorDocument` and `Document.ErrorObject` are document schemas; it is `ApiError`'s error _classes_ that carry HTTP status and content-type annotations.
  
  This is about the dependency, not the bytes. `effect/unstable/*` is pre-stable, so every unnecessary dependency on it is a version-compatibility surface — tree-shaking may drop the code, but it cannot drop the dependency.
  
  The root export is unchanged: it still exports every namespace, every symbol is the same object under both entry points, and no existing import is affected. The subpath is a packaging seam, not a second API — the generated docs are unchanged.
  
  Internally, `internal/media.ts` was reduced to the media type constants, with no imports at all; the annotation helpers it re-exported from the public `MediaType` module moved to `internal/httpMedia.ts` alongside `asJsonApiAtomic`. `MediaType` now takes `MEDIA_TYPE` from `internal/media.ts` instead of redefining it. No public behaviour changes.
  
  `Query`, `Handlers`, `Lid` and `Atomic` read as schema-only but are outside the tier: constraining include paths fails with `ApiError.UnsupportedIncludePath` / `UnsupportedIncludeDepth`, which are `HttpApi`-bound error classes, and the other three reach `Query`. Including them would mean separating `ApiError`'s error classes from their wire annotations — a change to a public module rather than a packaging one.
  
  The property is enforced mechanically by `test/entry-points.test.ts`, which walks the real import graph from the entry point (AST-based, counting type-only imports), pins the tier membership, repeats the check on the built artifact, and loads the published subpath in a child process where `effect/unstable/*` is unresolvable. Each check is paired with a control asserting it still detects a violation via the root barrel, so it cannot rot into a tautology.
- 5e308c7: The server skeleton: the ~2,000 lines of app-agnostic scaffolding three consuming applications each carried on top of this package, as idiomatic `HttpApi` modules.
  
  - **`ServerErrors`** — the domain error catalogue an operation raises (`NotFound`, `Unauthorized`, `Forbidden`, `Redirect`, `HttpError`, `ValidationFailure`), the `JsonapiError` carrier, `schemaIssueToErrors` (an Effect Schema issue tree to RFC 6901-pointed error objects), `fromTaggedError` (the catalogue, every `ApiError.make` class and a `JsonapiError` to its document; anything else stays a defect) and `respond`, the boundary every handler is wrapped in, with a `materialise` hook for the arms only an application can recognise (a database driver's unique violation as a 409).
  - **`Negotiation`** — the representation verdict for a host serving JSON:API on its page URLs: `make({ api })` derives `isApiPath` from every endpoint path and `negotiate(request)` decides dispatch from the request line and headers alone (a clean JSON:API instance winning `Accept` on a read, the JSON:API `Content-Type` on a write, §5's 406 / 415 at the seam, alternates such as a Markdown rendering negotiated first on their own paths), plus `requestForRouter`, `errorResponse`, `isMutatingMethod` and the host guards.
  - **`Document.wire`** and **`Document.Wire<T>`** — the wire variant of a resource schema (string links), which the flat documents declare.
  - **`Query.IncludeList`**, **`Query.includeListField`** and **`Query.flatList`** — the open `?include=` list in both spellings, and a flat list input put on the wire (`page[…]` / `filter[…]` bracketed, `include` added) in one call whose result `Query.canonicalPairs` applies to directly.
  - **`FlatQuery`** (also on the schema-only entry point) — the flat list-input grammar: `pagination` / `pageLimit` / `PageOffset`, `SortParam` / `sortField` (bounded at `MAX_SORT_FIELDS`, both wire spellings), `idList` / `IdList` / `idListField`, `slug` / `slugResourceFields` / `slugCreateFields`, `listInput`, and the tri-state reader `suppliedValue`.
  - **`Group.flat`** / **`Group.flatReadOnly`** — the CRUD and read-only presets over one resource, flat command inputs and a flat list query, returning `{ group, listQuery }`; **`Endpoint.flatRelated`**, **`Endpoint.relatedName`**, **`Endpoint.ResourceDocument`** / **`RelatedDocument`** / **`FlatCollectionDocument`** and **`Endpoint.FlatGetQuery`** for the longhand groups.
  - **`Assemble`** — the document assembler over `Handlers`: `resource`, `collection` (its include walk validated with `Query.validateIncludePaths` and resolved batched with `Handlers.resolveIncluded`), `relationship` (§8.4), `edgePage`, the capability hooks `roleCapabilities` / `ownedCapabilities` / `noCapabilities`, `stringifyLinks`, `toWireSafeResource` and `relationshipRefs`; generic in the viewer.
  - **`ResourceHandlers`** — `make` / `readOnly` / `related`: the handler set keyed by the presets' endpoint names, with the viewer, the link base, the transaction seam and the cache as parameters, `assertIdMatchesPath` failing `ApiError.Conflict`, and the list input inferred from the group's `listQuery` so an operation typed by a different input is a compile error.
  - **`Registry`** — `FamilyFor<G>` / `HandlersFor<G>` (the success channel checked against each endpoint's declared document), `checkFamily` (the module-init name-parity check), `familyLayer`, `layer`, `platformLayer` and `webHandler`.
  
  Also: `Middleware`'s media-type parser now reports an unparseable `q` rather than deciding it (the §5 check still treats it as a refusal; the negotiation verdict treats it as the default weight, as the applications did).
- 4c1eabf: Add the standard JSON:API query-parameter errors: `ApiError.UnsupportedIncludePath`, `ApiError.UnsupportedIncludeDepth`, `ApiError.UnsupportedSortField` and `ApiError.UnsupportedFieldsetMember` (grouped as `ApiError.QueryParameterErrors`), each carrying what the endpoint _does_ support in `meta` (`includablePaths`, `sortableFields`, `attributes`) so a rejection tells a client the legal set without a second request.
  
  Also adds `Query.validateIncludePaths`, a runtime validator (depth checked before membership, matching the whole dotted path) for resolvers that walk a whitelist not fully expressible as `Query.Include`'s closed schema.
  
  `UnsupportedSortField` and `UnsupportedFieldsetMember` are standalone declarations for now: `Query.schema`'s `sort` and `fields[TYPE]` codecs already validate against a closed, schema-build-time `Schema.Literals` set, so there's no dynamic "requested vs. supported" check point analogous to `include`'s (open-ended, resolver-validated) paths for them to be wired into yet.
  
  None of the four set `source.parameter` — `ApiError.Config` has no way to declare a `source` yet (tracked separately); once it does, these four are the natural first adopters.
- cb97cd1: **`Query.bracketKeys`: the general form of `Query.bracketPageKeys`.** Re-keys an arbitrary set of a flat query struct's encoded keys under an arbitrary bracket prefix — `page`, `filter`, `fields`, or one of your own — not just `offset` / `limit` under `page`. Composes when piped more than once onto the same struct, so a consumer-owned flat query struct can bracket several families at once without losing any of them (#111).
  
  ```ts
  const ListArticles = Schema.Struct({
    ...Query.Page.offset({ maxLimit: 100, fromString: false }),
    authorId: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.String),
  });
  
  const wire = ListArticles.pipe(
    Query.bracketKeys("page", ["offset", "limit"]),
    Query.bracketKeys("filter", ["status"]),
  );
  // wire:    { "page[offset]": …, "page[limit]": …, "filter[status]": …, authorId: … }
  // decoded: { offset, limit, status, authorId }   ← unchanged, still flat
  ```
  
  `Query.bracketPageKeys` is unchanged and now built on top of `bracketKeys` — `Query.bracketPageKeys(s)` is exactly `s.pipe(Query.bracketKeys("page", ["offset", "limit"]))`.
- 282f1ff: Add idempotent writes: the `Idempotency-Key` profile (#123)
  
  A retried `POST` duplicates. `lid` does not cover it — a local id correlates resources _within_ one request and says nothing about whether the request already ran. The new `Idempotency` module answers that as a JSON:API profile (`https://thomasfosterau.github.io/effect-jsonapi/profiles/idempotency/v1`), defined in full in [`docs/idempotency.md`](./docs/idempotency.md).
  
  - **The header, on the endpoints that honour it.** `Endpoint.create` / `update` / `delete` / `operations`, and the `Endpoint.resource` / `Group.resource` generators, take `idempotency: true | "required"`. It declares the `Idempotency-Key` request header (typed and parsed, not raw) and attaches `Idempotency.Middleware`, so an api carrying an idempotent endpoint does not type-check until a store is provided. Endpoints that do not opt in are unchanged.
  - **Replay is verbatim.** A retry carrying the same key gets the recorded response back byte for byte — the same status, headers and body — plus `Idempotency-Replayed: true`, so a `201` stays a `201` and typed clients keep working.
  - **The same key with a different body is an error, not a replay.** `422 Unprocessable Content` (`idempotency_key_mismatch`), checked before the in-flight case; a retry while the original is still running is `409 Conflict` (`idempotency_key_in_progress`). Both are JSON:API error documents carrying `source: { header: "idempotency-key" }`. A missing required key is the package's standard `400`.
  - **The store is a seam.** This package persists nothing: `Idempotency.Store` is three effects (`claim` / `complete` / `release`) the application supplies to `Idempotency.layer(store)`, with `claim`'s atomicity and the retention window as documented requirements. `Idempotency.memoryStore()` is a reference implementation for tests and single-process development.
  - **Atomic operations:** one key covers the whole request — the extension's own unit of atomicity — and replays the whole `atomic:results` document, so a replayed `lid` resolves to the id it resolved to the first time.
- 29228d5: Add a per-resource transform pass to the document builders, so sparse fieldsets and computed `meta` apply uniformly to primary data and `included`.
  
  `Handlers.data`, `Handlers.collection`, `Handlers.linkage` and `Handlers.buildIncluded` now take an `onResource` transform, applied **once per resource** to every slot the document has: the primary `data`, every deduplicated `included` member, and a linkage document's resource identifiers. It runs after dedup (so a transform runs once per distinct resource, not once per occurrence) and before the full-linkage check (so the check sees what the document actually emits). A resource reached in two slots is shaped once and reused, so it cannot come out two ways.
  
  Three transforms ship with it, plus an escape hatch:
  
  - `Handlers.project(fields)` / `Handlers.project(resource, fields)` — sparse fieldsets. A type with no requested set is returned unchanged (the spec's "every field", not "no field"), and only `attributes` is projected; `relationships`, `links` and `meta` are left alone. Relationship fields (`?fields[articles]=author`) are out of scope.
  - `Handlers.withMeta(compute)` — computed per-resource `meta`, merged over whatever the resource carries. An empty merged result emits **no** `meta` member rather than `{}`.
  - `Handlers.compose(first, second)` — one pass doing both.
  - `Handlers.transform<Lambda>(f)` — any other per-resource processing.
  
  A transform's effect stays visible in the document's type rather than widening to `ResourceValue`: `Handlers.data(article, { included, onResource: Handlers.project({ articles: ["title"] }) })` types both `data.attributes` and the included articles' `attributes` as `{ title: string }`. This is carried by a type-level function (`Handlers.TransformLambda` / `Handlers.Transformed`), since one transform is applied at several types in a single document. A plain function is still accepted and is checked against `Handlers.IdentityLambda` — it must return the resource's own type.
  
  `Handlers.DocumentValue`'s `Included` parameter is no longer constrained to `ResourceValue`, so it can name a transform's output type.
- 9126177: Make mutually-recursive resource definitions authorable.
  
  `Relationship.one(() => Person)` has always been a thunk, so the _runtime_ relationship graph could contain cycles. Inference could not: `Resource.make`'s return type is inferred, so an `Article` ⇄ `Comment` pair made each definition's type depend on the other's and TypeScript refused both with `TS7022` / `TS7024`. The ordinary parent ⇄ child JSON:API graph therefore had to hide one direction in a plain attribute (`productId`) and tell consumers about it out of band.
  
  A cyclic pair is now authorable with the same escape Effect's recursive schemas use — an explicit annotation on the recursive binding, which here is one `interface` per resource in the cycle:
  
  ```ts
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
  
  Attributes are hoisted to a `const` and referenced with `typeof`, so no attribute schema is restated. All four relationship kinds may take part in a cycle, self-references included, and everything derived from the definitions keeps working: `document()` / `collection()` (whose `included` union stays one hop wide, never the transitive closure), `?include=` path derivation (bounded by depth, not by the graph), create/update payloads, `Endpoint.*`, `Group.resource`, `Query.schema`, `Resource.extend` and `Resource.family`.
  
  Three supporting changes made it work:
  
  - **New:** the lowercase descriptor types `Relationship.one`, `Relationship.optional`, `Relationship.many` and `Relationship.paginated` — the types the constructors of the same name produce, defaults included (`one` / `optional` default to not filterable, `paginated` to no declared `order`). A resource definition is invariant in its relationship record, so an annotation has to name the type the constructor produced; these are it. A relationship that declares a `filter` or an `order` names it in the annotation, as the `const` tuple the constructor infers.
  - **New:** `Resource.Parameter<Type, Attributes, Rels, Meta, IdSchema>`, the parameter form of `Resource.Resource`, now used wherever the package takes a resource definition apart into its type parameters (`Endpoint.*`, `Group.resource`, `Resource.extend`, `Resource.family`). It reads `Type` off the definition's own `type` tag instead of inferring it structurally, which silently widened to `string` for an interface-annotated definition — taking every `Type`-derived default with it, starting with the endpoint path. As a type it is exactly `Resource.Resource`.
  - `Relationship.SchemaFor` now selects on the descriptor's `kind` tag rather than matching `D extends One<infer R>`, and the descriptor interfaces carry a phantom `~target` member so the target can be read by a plain indexed access. Matching a descriptor against the candidate interfaces made TypeScript relate the target resource back into the mapped type it was computing, which is the loop a cyclic graph could not close (`TS2615`). The two selections agree on every descriptor. `Relationship.TargetOf<D>` reads that phantom and is exported alongside it.
  
  The phantom member means a descriptor value assembled by hand (rather than through `Relationship.one` / `optional` / `many` / `paginated`) no longer satisfies the descriptor interfaces structurally. Use the constructors.
- 21d35b6: Add `Conformance` — an executable specification of JSON:API v1.1, and of this package's filter grammar profile, that a server can be driven through to prove it conforms.
  
  `Conformance.verify(api, { ids })` discovers your endpoints from the `HttpApi` value (method, path, declared query families, response media type) and then decides every rule against a real request/response pair over an in-memory transport wired to the real router — no port bound, no fixture beyond one known-existing id per resource type. `Conformance.verifyWith(api, { client, baseUrl })` runs the identical rules against a deployed server over any `HttpClient`. Conformance is a wire property, so the rules observe raw statuses, media-type parameters and unparsed bodies, and send the malformed requests a typed client cannot express.
  
  31 rules across two separately runnable tiers. The `spec` tier covers content negotiation (including the RFC 9110 §12.4.2 `q`-weight rules), document structure (top-level members, full linkage computed transitively, duplicate resources, resource identification, the `jsonapi` object), error objects and `source` discrimination, query-parameter handling (sparse fieldsets on primary data _and_ on `included`, unsupported `include` / `sort`, unknown parameters), 404 semantics and the atomic operations request document. The `profile` tier covers the filter grammar's advertisement, its rejections with `source.parameter`, and spelling equivalence between shorthand and group form, plus two library conventions (`jsonapi` version advertisement, the repeated-key query spelling). Pass `tiers: ["spec"]` to hold a server to the specification without adopting the profile.
  
  Failures name the rule, quote its normative sentence, cite its section and show the request that decided it. `Conformance.assert(report)` fails with a `ContractViolation` carrying all of that, and `Conformance.format(report)` renders the whole run.
  
  The report states what it did **not** check. A rule that could not run reports why — no endpoint of that shape, no sample id, a mutating probe not opted into — rather than passing vacuously, and `Conformance.gaps` declares the areas the kit does not cover at all (filter evaluation semantics, pagination-link and sort-ordering correctness, write semantics, atomic processing, link dereferenceability), each with its reason and tracking issues. Skips are counted separately from passes so a run that proved little cannot read as a clean one.
  
  Mutating probes are off by default, so a run is safe to point at a live server.

### Patch Changes

- 4471f9f: Fixed `Middleware.acceptIsAcceptable` and `Middleware.contentTypeIsAcceptable` (and the `Middleware.negotiate` predicate they back) incorrectly treating an `Accept` entry's `q` weight as a media type parameter. Per RFC 9110 §12.4.2, `q` terminates a media type's parameter list — it and anything after it are accept-extension parameters, not subject to JSON:API §5's ext/profile whitelist. Previously `application/vnd.api+json;q=0.9` was rejected outright, and a low-weighted JSON:API entry alongside a higher-weighted non-JSON:API one (e.g. `text/html;q=0.9, application/vnd.api+json;q=0.8`) produced a spurious 406. An entry weighted `q=0` is now correctly treated as an explicit refusal rather than a malformed parameter.
- 3f2f23a: Fix a phantom `unknown` requirement on every `:id` endpoint of a generated client
  
  The endpoint constructors that take an `:id` path parameter passed a bare field record as `params`, which left `HttpApiEndpoint`'s return type a deferred conditional. Declaration emit then serialised it with the conditional's true-branch narrowing baked in, as `Schema.Struct<Schema.Struct.Fields & { id: … }>`. That index signature admits `Schema.Top`, whose `DecodingServices` is `unknown`, so `get`, `update`, `delete`, `related`, `polymorphic` and the relationship methods on a client built with `HttpApiClient.make` each carried an `unknown` requirement that no layer could satisfy. Paramless endpoints (`list`, `create`, `collection`) were unaffected.
  
  The bug was only visible through the published `.d.ts`; type-checking against the sources resolved the same call sites cleanly, which is why the existing type-level tests never caught it. Passing `Schema.Struct({ id: … })` resolves the conditional eagerly, so the emitted parameter type is now a concrete `Schema.Struct<{ id: … }>` with no index signature, and the requirements come out as `never`. The parameter stays required and branded; the runtime behaviour is unchanged (`HttpApiEndpoint` already accepted a schema instance here).
  
  Consumers carrying a cast to launder the phantom requirement can drop it.
- 5205c5f: Migrate the toolchain to the Vite+ library standard.
  
  For consumers the package is the same API, built differently:
  
  - `dist/` is now emitted by `vp pack` (tsdown) — one ESM bundle per entry point (`.` and `./schema`) plus bundled declarations — instead of one file per module from `tsc`. The `exports` map and the two entry points are unchanged; the schema-only entry point still resolves `effect` and nothing else.
  - The sources compile under `exactOptionalPropertyTypes`. Every optional option a caller may pass an explicit `undefined` for (`Query.Options`, `Document.*`'s `included` / `meta` / `error`, `Handlers.data` / `collection` / `buildIncluded`'s `included` / `checkLinkage` / `onResource`, `Resource.make` / `extend`'s `id`, `attribute`'s `filterLiteral`) is now spelled `?: T | undefined`, so a consumer on that flag can forward its own optional values without a cast.
  - The published manifest declares its `effect` peer through pnpm's `catalogs.peers` (the floor itself is covered by this release's peer-floor entries) and is published with `pnpm publish` under npm OIDC trusted publishing.
  - `engines.node` is now `>=22`.

## 0.14.0

### Minor Changes

- facaa91: **`Resource.extend` accepts a custom `id` schema.** `extend(base, type, { id })` now mirrors
  `Resource.make`'s `id` option: the subtype's id is the consumer-provided schema and nothing else — no
  package brand is added — so a consumer that keys its subtypes with its own hierarchical brand
  catalogue (branding at the row-mapping seam via `AdminId.make(row.id)`) can use `extend` for subtype
  chains. The identifier, `ref`, payloads and documents follow the custom id exactly as they do for
  `make`. (#49)
  
  ```ts
  const AdminId = Schema.String.pipe(Schema.brand("AdminId"))
  const Admin = Resource.extend(Account, "admins", { id: AdminId })
  
  Admin.Id.make("1") // string & Brand<"AdminId">
  ```
  
  - `ExtendedId<BaseId, Type, Inherit, Custom = undefined>` gains a fourth parameter: `Custom` when
    given, else the existing `Inherit` behaviour, else the fresh `Id<Type>`.
  - `id` and `inheritId: true` are contradictory: the options type does not admit both, and passing
    both throws at definition time naming the two options.
  - Omit `id` and nothing changes — the default and `inheritId` behaviours are untouched.
- da55d44: **Input-only (write-only) attributes, and optional create attributes that accept `undefined`.**
  
  - `Resource.attribute(schema, { resource: false })` declares an attribute that is **accepted as
    input but never on the resource object** — an upload's binary, a password, a one-time token — so a
    write-only field is declarable in one place (#47). The attribute is absent from the resource
    `Schema.Struct` (at runtime and in the types: `ResourceFields["attributes"]` is now
    `Schema.Struct<ResourceAttributes<Attributes>>`), its documents, `AttributeKeys`, `attributeKeys`,
    `attributeAnnotations`, sparse fieldsets and `filterable` / `sortable`, while it still projects into
    `createPayload` / `createInput` and `updatePayload` / `updateInput` per its `create` / `update`
    settings, and into the atomic `add` / `update` operations.
  
    ```ts
    const Upload = Resource.make("uploads", {
      attributes: {
        fileName: Schema.NonEmptyString,
        file: Resource.attribute(FileSchema, { resource: false, update: false }) // create-only binary
      }
    })
    // Upload.Type.attributes  → { fileName }          Upload.createInput.Type → { fileName, file }
    ```
  
    The map _as declared_ stays reachable as `Upload.declaredAttributes` / `Resource.declaredAttributes(R)`
    (`Resource.DeclaredAttributesOf<R>`); `Resource.attributes(R)` keeps returning the resource-object
    map. `Resource.extend` inherits input-only attributes; name-only families keep intersecting
    resource-object fields. `Resource.make` throws, naming the attribute, for `resource: false` combined
    with both `create: false` and `update: false` (declares nothing), or with a `filter` / `sort`
    declaration (not on the resource object, so nothing to filter or sort by). `AttributeConfig` gains a
    trailing `Resource` parameter (defaulting to `true`).
  
  - `create: "optional"` now projects as `Schema.optional(S)` — the key may be absent, or present with
    a value or an explicit `undefined` — instead of the strict `Schema.optionalKey(S)`, matching what
    `updateInput` / `updatePayload` already do (#48). A caller building `{ x: maybeUndefined }` (a form
    adapter computing `x: input.x?.trim() || undefined`) now type-checks against `createInput` under
    `exactOptionalPropertyTypes` as it already did against `updateInput`. This is a **type widening** of
    `createInput` / `createPayload` (and the atomic `add` operation) for optional attributes: the field
    schema is `Schema.optional<S>` rather than `Schema.optionalKey<S>`, so its `Type` is
    `S["Type"] | undefined`. The same widening applies to a **bare `Schema.optionalKey(S)` attribute**
    (no descriptor), which the update side already widened; a bare `Schema.optional(S)` attribute is
    unchanged. On a JSON wire an explicit `undefined` and an absent key are the same thing. Code that
    pinned the `optionalKey` shape needs the wider type; nothing that decoded before is rejected now.
  
  - `Resource.attribute`'s `resource` option must be a literal (`true`, `false` or `"optional"`): a
    non-literal `boolean` is now a compile error, since the resource-object type cannot be decided from
    it.

## 0.13.0

### Minor Changes

- 555802f: **The canonical query string: `Query.canonical(schema)`, with the pagination link builders and
  `Handlers.collection` carrying the request's full query.** JSON:API 1.1 requires a collection
  document's `self` link to carry the query parameters the client provided; a decoded query now has
  exactly one wire spelling, produced by one function with one ordering rule.
  
  ```ts
  const listQuery = Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: true
  })
  const canonical = Query.canonical(listQuery)
  
  canonical(query)
  // → "include=author&fields[articles]=title&filter[status]=open&sort=-createdAt&page[offset]=0&page[limit]=10"
  ```
  
  - **One order.** `include`; `fields[*]` sorted by type; `filter[*]` in the filter grammar's
    canonical order (shorthand sorted by key, the group form in the encoder's pre-order); `sort`;
    `page[*]` in the page strategy's declared order (`offset, limit` — what the link builders already
    emit); then any other key sorted. Two equal decoded queries produce byte-identical strings whatever
    spelling they came from (key order, `?include=a&include=b` against `?include=a,b`,
    `filter[f][eq]=v` against `filter[f]=v`), and the string decodes back to the same query.
  - **One encoding.** `Query.serialise(pairs)`: RFC 3986 percent-encoding via `encodeURIComponent`
    (spaces `%20`, commas `%2C` — a list's separator and the grammar's `\,` alike), `[` / `]` left
    readable in keys, pairs joined with `&`. `URLSearchParams` / `UrlParams` decode it back
    identically. `Query.canonicalPairs(schema)` is the ordered pair list before serialisation.
  - **Link builders.** `Handlers.offsetPaginationLinks` / `numberPaginationLinks` now serialise
    through `Query.serialise` (their output is unchanged) and take an optional fourth argument
    `{ query: Query.canonicalPairs(listQuery)(query) }` — the request's other canonical pairs, into
    which each page cursor is slotted — so `self` / `first` / `prev` / `next` / `last` carry the
    full `include` / `fields` / `filter` / `sort`.
  - **`Handlers.collection`** takes a `query` option (the canonical pairs or string) appended to its
    `self` link, for collections that are not paginated.
- f59b77c: **The `filter` URL codec: `filter: true`, `Query.Filter(resource)` and the `Filter.Ast`.**
  The filter grammar in `docs/filter-grammar.md` is implemented over the per-attribute declaration.
  `Endpoint.list(R, { filter: true })` (and `Query.schema(R, { filter: true })`) decodes the
  `filter[...]` family to one normalised `Filter.Ast` root node, typed over the declared fields, and
  encodes a tree back to its canonical wire form.
  
  ```ts
  const Product = Resource.make("products", {
    attributes: {
      priceCents: Resource.attribute(Schema.Int, { filter: ["eq", "gt", "lt"] }),
      status: Resource.attribute(Schema.Literals(["draft", "live"]), { filter: true })
    }
  })
  
  Endpoint.list(Product, { filter: true })
  // GET /products?filter[status]=live&filter[priceCents][lt]=1000
  // → query.filter = And([Compare(lt, priceCents, 1000), Compare(eq, status, "live")])
  ```
  
  - **Surface.** `filter[f]=v` is `eq`, `filter[f]=a,b` is `in`, `filter[f][op]=v` any of the closed
    core `eq ne lt lte gt gte in nin isnull`; the Drupal-style group form
    (`filter[g][group][conjunction]=OR`, `filter[c][condition][path|operator|value|memberOf]`) spells
    `OR`, `NOT`, nesting and repeated `(field, operator)` pairs. Literals are decoded through the
    attribute's literal codec, with `\,` and `\\` as the only escapes.
  - **AST.** `Filter.Ast<Fields>` — `Compare`, `In`, `NotIn`, `IsNull`, `And`, `Or`, `Not` — plus the
    untyped `Filter.Node`, a runtime `Filter.Ast` schema, dumb constructors (`Filter.eq`, `Filter.isIn`,
    `Filter.and`, …) and `Filter.normalise`. `Query.FilterAst<R>` narrows `field` to the declared names
    and each literal to its field's type.
  - **Canonical form.** Decoding normalises (values and members sorted and deduplicated); encoding
    emits the shorthand when it round-trips and the group form with pre-order ids otherwise, so the
    canonical string is a function of the tree alone. `Filter.PROFILE_URI` (also
    `Query.FILTER_PROFILE_URI`) is the grammar's profile URI.
  - **Errors.** Every rejection — unknown field, undeclared operator, bad literal, malformed key,
    repeated key, and each structural fault of the group form — is one issue whose path is the
    offending flat key, and the schema-error middleware now renders a request-validation failure as an
    error object per reported issue, with `source.parameter` (`filter[age][gt]`, `page[limit]`),
    `source.header` or `source.pointer` (`/data/attributes/title`) and the issue's message as `detail`
    (`Middleware.schemaErrorDocument`). HttpApi decodes with `errors: "first"`, so a request part yields
    one error object; the `filter` family is the exception, its codec reporting every offending key
    together. A failure with no derivable source keeps the previous single-error document.
  - The per-key `filter: { q: Schema.String }` map is unchanged and remains the escape hatch; a
    heterogeneous endpoint must use it (`filter: true` throws at definition time).
  - `ApiError` wire schemas now decode an error document whose `meta` omits an optional field, instead
    of failing on the absent key.
- 8164019: **Per-attribute `filter` / `sort` declarations — `Filter.able` / `Sort.able` — with `Resource.filterable`
  and `Resource.sortable`.** Filterability is now declared on the resource, per attribute, rather than
  left to an open per-endpoint `filter: { key: Schema }` map. The declaration is made on the attribute
  schema itself, with pipeable, Effect-native combinators, and rides with it as a schema annotation
  (`Filter.AnnotationId` / `Sort.AnnotationId`) — the single source of truth the accessors read back —
  so it is carried through `Resource.extend`, `Resource.attributes` spreads, `resource: "optional"`,
  `Schema.NullOr` and `Schema.optionalKey`.
  
  ```ts
  import { Filter, Resource, Sort } from "@thomasfosterau/effect-jsonapi"
  
  const Product = Resource.make("products", {
    attributes: {
      name: Schema.NonEmptyString, // neither filterable nor sortable
      priceCents: Schema.Int.pipe(Filter.able([Filter.Op.eq, Filter.Op.gt, Filter.Op.lt]), Sort.able()),
      discontinued: Schema.Boolean.pipe(Filter.able()), // the whole operator core
      createdAt: Resource.readOnlyAttribute(Schema.DateFromString.pipe(Sort.able()))
    }
  })
  
  Resource.filterable(Product) // { priceCents: { operators, literal }, discontinued: { … } }
  Resource.sortable(Product) // ["priceCents", "createdAt"]
  Endpoint.list(Product, { sort: Resource.sortable(Product) })
  ```
  
  - `Filter.able()` admits the whole operator core, `Filter.able([...])` a subset in the order given;
    `Sort.able()` allows `?sort=`. Absent means not filterable / not sortable — the default fails
    closed, like `include` / `fields` / `sort`. An empty list or an operator outside the core is a
    compile error and a definition-time throw. Annotate last, for the types: the runtime declaration
    survives a later `.check` / `.annotate` / `Schema.brand`, but any rebuild drops the type-level
    marker.
  - `Resource.attribute(schema, { filter, filterLiteral, sort })` (and `Resource.readOnlyAttribute`)
    are **sugar** for those calls on the inner schema and stamp nothing else, so both spellings are
    indistinguishable to the accessors and to the types.
  - The operator vocabulary is **schema-backed, not stringly typed**: `Filter.Operator` is a
    `Schema.Literals` over `eq ne lt lte gt gte in nin isnull`, from which `Filter.operators` and
    `Filter.isOperator` derive; `Filter.Op` spells the operators as typed constants (`Filter.Op.gt` is
    `"gt"`), so a typo is a compile error while plain strings stay accepted.
  - Each filterable attribute gets a **literal codec** (`Schema.Codec<Type, string>`) derived from its
    schema's encoded form — `string`, `number`, `boolean`, or `Schema.NullOr` of one. The wire string is
    parsed strictly (`number` accepts only a finite decimal, `boolean` only `true` / `false`) and then
    decoded through the attribute schema itself, so refinements, brands, literal unions and
    `DateFromString` apply and `filter[priceCents][gt]=abc` fails decoding. An attribute whose encoded
    form is not a scalar cannot be declared filterable — `Resource.make` throws, naming it — unless the
    declaration supplies an explicit codec: `Filter.able(ops, { literal })`.
  - To-one relationships are filter fields too: `Relationship.one(ref, { filter })` and
    `Relationship.optional(ref, { filter })` admit `eq ne in nin isnull` — `Relationship.FilterOperator`,
    a `Schema.Literals` narrowing `Filter.Operator` (`true` means those five, an ordering operator is a
    definition-time error) — valued by the related resource's id: the literal codec is the target's `Id`
    schema, resolved lazily, so `filter[author]=9` decodes to the branded id. `Resource.filterable(R)`
    lists them alongside the attributes; `Resource.sortable` stays attributes only.
  - `Resource.sortable(R)` is typed as the literal key union, so it drops straight into
    `Query.schema(R, { sort: Resource.sortable(R) })` and `Endpoint.list(R, { sort: … })`. `sort: true`
    keeps meaning "every attribute".
  - Type-level: `Resource.FilterableKeys<R>`, `Resource.FilterOperators<R, K>`, `Resource.SortableKeys<R>`,
    `Resource.Filterable<R>`, `Resource.FilterLiteralType<S>` (alias of `Filter.LiteralType`),
    `Filter.Declared<S, Op>` / `Sort.Declared<S>` (the phantom-marked schema types) and
    `Resource.FilterDeclaration` (the `filter` sugar's shape).
  
  `Query.schema` is unchanged in this release; the `filter` URL codec over the declaration (the
  grammar in `docs/filter-grammar.md`) follows separately.

## 0.12.0

### Minor Changes

- 6f6314a: **The injected `IdSchema` is threaded through the endpoint constructors.** `Resource.make` has
  accepted a custom id schema since 0.4.0, but no endpoint constructor carried it: `Endpoint.get` /
  `list` / `create` / `update` / `delete`, the relationship constructors, `Endpoint.resource` and
  `Group.resource` all typed their resource parameter as `Resource<Type, Attributes, Rels, Meta>`,
  whose fifth type parameter defaults to the derived `Id<Type>`. A resource carrying the consumer's
  own branded id — the case the injection was added for — was therefore not assignable to any of
  them, and had to be cast at the call site even though the runtime was already correct (the
  constructors read `resource.Id` verbatim).

  Each of those constructors now takes the id schema as a type parameter of its own, defaulting to
  the derived `Id<Type>`, and threads it into `Resource<…>`:

  ```ts
  const InvoiceId = Schema.String.pipe(
    Schema.brand("AccountId"),
    Schema.brand("InvoiceId"),
  );
  const Invoice = Resource.make("invoices", {
    id: InvoiceId,
    attributes: { total: Schema.Number },
  });

  // no cast at any of these, and `:id` is `InvoiceId` rather than `Id<"invoices">`
  Endpoint.get(Invoice);
  Group.resource(Invoice);
  ```

  The brand reaches the `:id` path parameter and the documents each endpoint declares by default —
  the success document, the collection, `updatePayload` — so a handler and a generated client see the
  resource's real id type rather than the derived one. No runtime behaviour changes: the constructors
  already passed `resource.Id` through, and a resource with no injected id infers exactly what it
  inferred before.

  The parameter sits fifth, where it sits on `Resource` itself, on the constructors whose remaining
  parameters are all defaulted (`get` / `list` / `create` / `update` / `delete`, `Endpoint.resource`,
  `Group.resource`), and ahead of the parameter list's first required member elsewhere
  (`Endpoint.related` and the relationship constructors, `ResourceOptions`, `ResourceEndpoint`,
  `ResourceEndpoints`). That is visible only to code that instantiates one of them explicitly —
  `typeof Endpoint.get<…>`, `ResourceOptions<…>` — never to a normal call site.

## 0.11.0

### Minor Changes

- a7f3bbb: **Repeated `?include=` keys, and a `query` override on `Endpoint.get`.** Two halves of the same gap
  on the read path.

  `Query.schema` declared `include`'s wire form as `Schema.optionalKey(Schema.String)`, so the
  repeated-key spelling — `?include=a&include=b`, which `UrlParams.toRecord` decodes to an **array** —
  failed to decode and answered 400, where the comma form `?include=a,b` denoting the same set answered 200. Both spellings are now accepted and decode identically; encoding still emits the single comma
  form, so nothing a client is handed changes shape, and an unknown or unlisted path is still the 400
  it was in either spelling. No opt-in: this is a widening of the parameter the package composes.

  `Endpoint.get` also gains the `query` override `Endpoint.list` has carried since 0.9.0 — any
  `Schema.Top`, defaulting to today's `include` / `fields` composition, with those options ignored once
  it is given — threaded through `Endpoint.resource` / `Group.resource`'s per-endpoint `get` config,
  and `GetConfig` gains the matching `query` field:

  ```ts
  Endpoint.get(Article, {
    query: Schema.Struct({
      include: Schema.optionalKey(Schema.String),
      includeDeleted: Schema.optionalKey(Schema.Literals(["true", "false"])),
    }),
  });

  Group.resource(Article, { endpoints: { get: { query: GetArticle } } });
  ```

  Only the query changes; the `:id` path param, success document, errors and middleware are untouched.
  `Endpoint.get`'s type parameter list gains `QuerySchema` before `Success`, mirroring `list` — visible
  only to code that instantiates `typeof Endpoint.get<…>` explicitly, never to a normal call site.

- 74503fd: **`status` option on `Endpoint.create` / `Endpoint.update`.** `create` stamped `201` on its success
  schema unconditionally — re-stamping even a caller-supplied `success` — and `WriteConfig` carried no
  `status`, so an api whose creations answer `200` could not adopt the constructors without a wire
  change. Both constructors now take an optional `status`, defaulting to today's `201` for `create` and
  `200` for `update` whether or not `success` is given, and it is threaded through
  `Endpoint.resource` / `Group.resource`'s per-endpoint `create` / `update` config. This is the
  `status` `DeleteConfig` has carried since 0.9.0, on the write endpoints:

  ```ts
  Endpoint.create(Article, { status: 200 });
  Endpoint.update(Article, { status: 202 });

  Group.resource(Article, {
    endpoints: { create: { status: 200 }, update: { status: 200 } },
  });
  ```

  Only the status changes; path, params, request payload, success schema, errors and middleware are
  untouched.

- 0b79079: **`payloadMediaType` option on `Endpoint.create` / `Endpoint.update`.** Both constructors wrapped
  their `payload` — the override included — in the JSON:API media type, so the router's _request_
  registration was always `application/vnd.api+json` with no way out. Effect's router answers 415 on a
  mismatched request `Content-Type`, so a host that enforces §6 at its own seam and then dispatches
  writes to the router relabelled `application/json` had every package-built write rejected before a
  handler saw it.

  Both now take an optional `payloadMediaType`, defaulting to today's `application/vnd.api+json`, and
  it is threaded through `Endpoint.resource` / `Group.resource`'s per-endpoint `create` / `update`
  config:

  ```ts
  Endpoint.create(Article, {
    payload: Article.createInput,
    payloadMediaType: "application/json",
  });

  Group.resource(Article, {
    endpoints: { create: { payloadMediaType: "application/json" } },
  });
  ```

  Only the request registration moves: the payload schema, the response media type, path, params,
  errors and middleware are untouched. Pair it with `Middleware.layerHostNegotiated` — the counterpart
  for the negotiation half — so the package's own §5 check doesn't reject what the host admitted.

## 0.10.0

### Minor Changes

- ea5d196: **`success` override on `Endpoint.get` / `list` / `create` / `update`.** The constructors bound their
  response unconditionally to the resource's `document()` / `collection()`, so the only shape a
  handler could answer with was the resource itself. They now take an optional `success` schema —
  any `Schema.Top`, like `payload` — defaulting to exactly those documents, for apis whose response is
  a _wire variant_ of the resource: an assembler that stringifies every link before the document
  leaves the server emits `links.self` as a plain string, where the resource's own `Document.Link`
  decodes an absolute reference to a `URL` and hands every generated-client call site the wrong type.
  The override is served as `application/vnd.api+json` like every other body in the package, at 201
  for `create` as before, and the document envelope is untouched, so `Handlers.offsetPaginationLinks`
  and the other handler helpers still apply to an overridden `list`. The option is threaded through
  `Endpoint.resource` / `Group.resource`'s per-endpoint `get` / `list` / `create` / `update` config,
  so a generated group can adopt the wire variant without being spelled out by hand. Only the response
  changes — path, params, query parameters, request payload, errors and middleware are untouched.

## 0.9.0

### Minor Changes

- 58956ac: **Constrainable `include` paths.** `Query.Include` derived the resource's whole relationship graph
  to a depth of 2, and `include` was a boolean over that set — so an endpoint advertised every path
  the graph reaches, including ones its resolver was never written for. Advertising an unresolvable
  path answers 200 with an empty `included`, which is strictly worse than the 400 an unknown path
  already produces.

  `Query.Include` now takes an options object — `paths` (an explicit allow-list) and/or `depth`
  (`1` / `2` / `3`; `paths` wins when both are given) — and the same object may be passed as `include`
  wherever a boolean was accepted: `Endpoint.get` / `list` / `related` / `collection` /
  `polymorphic`, `Query.schema`, and `Endpoint.resource` / `Group.resource` both top-level and per
  endpoint. The literal path type narrows with the runtime set, so an unlisted path fails to compile
  as well as to decode. `include: true` still means today's full-graph depth-2 derivation, and the
  relationship endpoints — whose paths are their target's graph, not the configured resource's —
  inherit only that `include` is on.

  Adds `Resource.IncludeDepth` and `Resource.IncludePathsTo<R, Depth>` (the type-level mirror of
  `Resource.includePaths`' `maxDepth`), plus `Query.IncludeOptions` / `Query.IncludeOption` /
  `Query.IncludePathsOf`. `Query.Include<R>` gains a second, defaulted type parameter for its path
  set; `Endpoint.GetConfig<Meta>` gains a second, defaulted parameter for the resource it configures.

- aa7784b: **`query` override on `Endpoint.list`.** The constructor composed its query schema from the
  `include` / `fields` / `sort` / `page` / `filter` options and offered no way out of that composition,
  which always nests what it decodes (`page: { offset, limit }`, `filter: { … }`). It now takes an
  optional `query` schema — any `Schema.Top` — defaulting to that composition, for apis whose list
  contract is a flat struct their own operations layer consumes: a page cursor bracket-keyed on the
  wire but decoded flat (see `Query.bracketPageKeys`), entity foreign keys, and flags JSON:API has no
  query family for, which `filter` would otherwise put on the wire as `filter[<name>]`. The feature
  options are ignored once `query` is given. The option is threaded through `Endpoint.resource` /
  `Group.resource`'s per-endpoint `list` config. Only the query changes — path, success document,
  errors and middleware are untouched.
- fc6c707: **`success` override on `Endpoint.delete`.** The constructor bound its response unconditionally to
  `HttpApiSchema.NoContent`, so every generated delete was a 204 with an empty body. It now takes an
  optional `success` schema (and a `status` for the rare non-200 case), defaulting to that 204, for
  apis whose deletion answers with a body — a soft delete that marks the row deleted, re-reads it and
  returns the tombstone resource document. The override is served as `application/vnd.api+json` like
  every other body in the package. The option is threaded through `Endpoint.resource` /
  `Group.resource`'s per-endpoint `delete` config, so a generated group can adopt tombstone deletes
  without being spelled out by hand. Only the response changes — path, params, errors and middleware
  are untouched.

## 0.8.0

### Minor Changes

- fdb8e3b: Migrate off `Schema.TaggedErrorClass`, which effect removed in `4.0.0-beta.104` (renamed to
  `Schema.TaggedError`). The peer dependency requirement moves accordingly:
  `peerDependencies.effect` is now `>=4.0.0-beta.104` — a breaking change for consumers on
  effect `<= 4.0.0-beta.103`, who should stay on `effect-jsonapi@0.7.x`.

  `ApiError.make`'s runtime behavior and public types are unchanged; only the underlying effect
  call site moved. A handful of other effect API renames landed in the same range and are adapted
  here too: `HttpApiEndpoint.Any` → `HttpApiEndpoint.Top`, and the `HttpApiSchemaError` a
  `SchemaErrors` middleware handles can now carry a `"ResponseHeaders"` kind (a server-side response
  schema failure), which is now re-raised rather than mislabeled as a client 400.

  Also: effect's `Schema` values (including this package's `Resource` definitions) are now callable
  at runtime, so `Resource.Ref` and `Resource.isFamily` no longer rely on `typeof value === "function"`
  / `typeof value === "object"` to tell a resource from a lazy thunk — both public functions still
  behave the same for callers.

## 0.7.0

### Minor Changes

- 70343a7: Three additions for consumers whose transport doesn't match the package's defaults. All are opt-in
  and default to today's behaviour.

  **`payload` override on `Endpoint.create` / `Endpoint.update`.** Both constructors bound their
  request body unconditionally to the resource's `createPayload` / `updatePayload` — the nested
  JSON:API envelope. They now take an optional `payload` schema, defaulting to that envelope, for apis
  whose write contract is a flat command input (the resource's own `createInput` / `updateInput`, or
  any schema of your own) while still answering with JSON:API documents. The option is threaded
  through `Endpoint.resource` / `Group.resource`'s per-endpoint `create` / `update` config, so a
  generated group can adopt flat writes without being spelled out by hand. Only the request body
  changes — path, params, success document, errors and middleware are untouched.

  **`Query.bracketPageKeys`.** A standalone combinator re-keying a flat `{ limit, offset, … }` struct's
  page cursor to the spec-canonical `page[limit]` / `page[offset]` wire family, leaving the decoded
  type and every other field's wire key alone. `Query.schema`'s `page` option was the only route to
  those bracket keys, and it always nests the decoded cursor under `page` — this serves consumers who
  merge pagination flat into their own query struct instead of composing the whole query through
  `Query.schema`. No change to existing `Query.schema` paths.

  **Middleware usable without the endpoint constructors.** `Middleware.schemaError(part)` returns the
  JSON:API 400 that request validation produces, standalone — the counterpart to the existing
  `Middleware.negotiate`, so a framework hook that owns the URL can answer byte-identically to an
  `Endpoint`-built api. `Middleware.layerHostNegotiated` (and `Middleware.ContentNegotiationPassthrough`
  alone) satisfies the constructors' `ContentNegotiation` requirement without performing §5, for apis
  whose host already negotiated content upstream and would otherwise negotiate twice.

## 0.6.0

### Minor Changes

- 565071e: Decode JSON:API URI members to real `URL`s instead of plain strings.

  A new `Document.Url` schema decodes an **absolute** URI-reference to a WHATWG
  `URL` and leaves a **relative** reference (which the spec permits, and which the
  server-side `Handlers` helpers emit) as a `string` — its decoded type is
  `URL | string`. Both forms encode back to the original string, so the wire
  format is unchanged and relative links keep working.

  `Document.Url` is now used wherever the spec calls for a URI:

  - link targets — `Document.Link` and `LinkObject.href` (so `self` / `related` /
    pagination links across `TopLevelLinks`, `ResourceLinks`, `RelationshipLinks`
    and the error object's `about` / `type` links);
  - `LinkObject.describedby`;
  - the top-level `jsonapi` object's `ext` and `profile` URI arrays.

## 0.5.0

### Minor Changes

- f5e663f: Add **polymorphic resource families** (`Resource.family`) — a supertype over a set of member
  resources for heterogeneous "any node" use (closes #41).

  A family **is** the discriminated union over its members (decoded by the `type` tag) **and**
  structurally satisfies `Resource.Any`, so it can be used as primary `data`, as a compound
  `included` member, and — the headline — as a **relationship target**
  (`Relationship.one(() => family)` / `optional` / `many` / `paginated`), where linkage decodes for
  any member (keyed on the member `type`, never the family name) with no changes to the relationship
  machinery.

  - `Resource.family(Base, [A, B])` — base-anchored (recommended): the shared `Id` /
    `relationships` / attributes come from `Base`, so the shared id brand anchors "any member id"
    and dotted `?include=` paths through the family are meaningful (pair with members defined as
    `extend(Base, …, { inheritId: true })`).
  - `Resource.family("name", [A, B])` — named, no base: the shared id is a union of the members'
    ids and the shared relationships/attributes are the by-key intersection.
  - `family.document()` / `family.collection()` derive documents whose `data` is the member union
    and whose `included` spans every member's targets.
  - `Endpoint.polymorphic(family, …)` is the single-resource `GET /family/:id` (returning any
    member); `Endpoint.collection(family.members, …)` and `Group.make(family, …)` already cover the
    collection and group cases.
  - `Resource.isFamily`, `Resource.Family`, `Resource.FamilyIdentifier`,
    `Resource.FamilyDefaultIncluded`, `Resource.FamilyIncludePath`, `Resource.FamilyIncluded`.

  Strictly additive — no existing signatures change.

- dbada1f: Add **per-attribute projection descriptors** — control how each attribute appears in the resource
  object versus the four write projections (additive, no breaking changes):

  - **`Resource.attribute(schema, options)`.** Declares a per-attribute projection. Options (all
    optional; the defaults reproduce a plain `Schema` attribute):

    - `resource` — presence in the resource object schema + documents: `true` (default) or
      `"optional"` (an optional key).
    - `create` — presence in `createPayload` / `createInput`: `"required"` (default), `"optional"`,
      or `false` (excluded).
    - `update` — presence in `updatePayload` / `updateInput`: `"optional"` (default, tri-state) or
      `false` (excluded).
    - `clearable` — whether the update projection additionally accepts `null` to clear; defaults to
      whether the schema is `Schema.NullOr`.

  - **`Resource.readOnlyAttribute(schema)`.** Shorthand for a server-set attribute —
    `attribute(schema, { create: false, update: false })`: present in the resource object and
    documents, excluded from every write projection. Use it for version-chain timestamps
    (`createdAt`, `updatedAt`, …), counters and other server-computed state.

    ```ts
    const Article = Resource.make("articles", {
      attributes: {
        title: Schema.NonEmptyString,
        createdAt: Resource.readOnlyAttribute(Schema.Date),
        slug: Resource.attribute(Schema.String, { update: false }),
        summary: Resource.attribute(Schema.NullOr(Schema.String), {
          create: "optional",
        }),
      },
    });

    // Article.Type.attributes                  → { title, createdAt, slug, summary }
    // Article.createPayload … data.attributes  → { title, slug, summary? }   (no createdAt)
    // Article.updatePayload … data.attributes  → { title?, summary? }        (no createdAt, no slug)
    ```

  A plain `Schema` attribute keeps today's read-write behaviour, so the feature is fully opt-in. The
  descriptor rides on the attribute's schema value, so it flows through `attributeKeys`,
  `attributeAnnotations`, sparse `fields` and `include`, is carried through `Resource.extend`, and is
  respected by the Atomic `add` / `update` operations — consistently with the create/update payloads.
  The type-level projection helpers `Resource.Attribute`, `Resource.AttributeConfig`,
  `Resource.CreateAttributes` and `Resource.UpdateAttributes` (and the runtime
  `Resource.createAttributeFields` / `Resource.updateAttributeFields`) are exported too.

## 0.4.0

### Minor Changes

- dafe9ff: Unblock higher-level adoption with five additive features (no breaking changes):

  - **Custom id-schema injection.** `Resource.make` accepts an optional `id` schema (any codec whose
    `Encoded` is `string`), so a resource's id can carry a consumer-defined brand instead of the
    auto-derived `Resource.Id`. The id type is threaded through `Resource`, `Identifier`,
    `updatePayload`, and the document schemas (a new, defaulted last type parameter — existing
    callers are unchanged). `Resource.Identifier(type, id?)` accepts a custom id schema too.
  - **Subtype ids on extend.** `Resource.extend(Base, type, { inheritId: true })` brands the base's id
    schema with the child's type, so the child id accumulates the base's brand(s) and is assignable
    wherever the base id is expected — a true subtype relationship, transitive through an `extend`
    chain (`Admin.Id` ⊂ `Account.Id`). Defaults to `false` (an independent brand, as before).
  - **Tri-state update payloads.** A resource's `updatePayload` now models PATCH semantics distinctly
    per attribute via `Schema.optional`: an **absent** key means _leave unchanged_, an **`undefined`**
    value means _unset_, and a present value means _set_. Nullable attributes (`Schema.NullOr(...)`)
    therefore accept `value | null | undefined`.
  - **Per-attribute annotations.** `Resource.attributeAnnotations(resource)` reads the Effect schema
    annotations stamped on each attribute (e.g. a `dbColumn` mapping authored with
    `schema.annotate({ ... })`), so metadata can ride alongside an attribute schema.
  - **Flat ("command-style") payloads.** Resources expose `createInput` and `updateInput` — flat
    attribute structs without the JSON:API `{ data: { type, ... } }` envelope — for transports (RPC,
    remote functions) that carry a flat request shape.
  - **Document value types.** `Handlers.DocumentValue` is now exported (with an optional `jsonapi`
    member and `Handlers.JsonApiObjectValue`), and `Document.Value<R>` names a data-document value
    type, so consumers can annotate their document-assembling functions instead of hand-rolling the
    envelope.
  - **Decoupled middleware.** `Middleware.negotiate(headers, options?)` runs JSON:API §5 content
    negotiation outside Effect's HttpApi (returning the offending `UnsupportedMediaType` / `NotAcceptable`
    or `undefined`), and `ApiError.toDocument(error)` encodes any `ApiError` instance to a JSON:API
    error-document value — so a plain framework hook can reuse the negotiation and error machinery.

## 0.3.0

### Minor Changes

- 0da7692: Add `Query.Page.offset` (bounded, defaulted, optional plain-number) factory.

  `Query.Page.offset(options?)` returns the same `{ offset, limit }` field-map as the constant `Query.Page.Offset`, but configurable:

  - **Bounded** — `maxLimit` caps `limit` (a DoS guard); `minLimit` (default 1) floors it.
  - **Defaulted** — `defaultLimit` / `defaultOffset` fill in concrete values on decode when the wire key is absent; omit one to leave that field optional.
  - **Coercion-flexible** — `fromString: false` builds the fields from plain `Schema.Number` (encoded = number) instead of `FiniteFromString` (encoded = string), so the same schema works both as a numeric call-site input and behind a transport that coerces query strings (raw `HttpApiEndpoint` wrapped in `Schema.toCodecStringTree`).

  A page-number twin, `Query.Page.number(options?)`, applies the same bounds/defaults to the `size` field (1-based `number`). The existing `Page.Offset` / `Page.Number` / `Page.Cursor` constants are unchanged.

  ```ts
  Endpoint.list(Article, {
    page: Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }),
  });
  ```

## 0.2.0

### Minor Changes

- 7cb72be: **Breaking:** `Document.DataDocument` is now a pure envelope — its `data` member is exactly the schema you pass, dropping the implicit `Schema.NullOr`. `DataDocument(R)` changes from `data: R | null` to `data: R`.

  JSON:API only permits `null` primary data for a single-resource request whose URL might correspond to a resource but currently doesn't ([§Fetching Resources → 200 OK](https://jsonapi.org/format/1.1/#fetching-resources-responses-200)). Fetch-existing / create (201) / update (200) always carry the resource — a missing one is a `404`, never `200 { data: null }` — so nullability is now the caller's compositional decision rather than something the constructor bakes in:

  ```ts
  DataDocument(Article); //                  data: Article            (was: Article | null)
  DataDocument(Schema.NullOr(Article)); //   data: Article | null
  DataDocument(Article.nullable()); //       data: Option<Article>, ⇆ null on the wire
  ```

  **Migration:** restore the old shape by wrapping the argument — `DataDocument(Schema.NullOr(R))`. Downstream this lets consumers delete hand-rolled non-null single-resource envelopes (e.g. a website's `ResourceDocument` becomes `Document.DataDocument(wireResource(resource))`).

  Ripple effects:

  - `Resource.document()` and `Endpoint.fetch` / `Endpoint.create` / `Endpoint.update` now produce non-null primary `data` (the canonical single-resource document for an existing resource).
  - `Endpoint.related` for a to-one relationship keeps the nullable form (`data: target | null`) to preserve the empty-linkage `data: null` case.
  - New `Resource.nullable()` method on every resource definition — `Article.nullable()` is `Schema.OptionFromNullOr(Article)`, the blessed, spec-clean nullable codec (`None ⇆ null`) for `Document.DataDocument(Article.nullable())`. Prefer it over effect's structural `Schema.Option` (`{ _tag, value }`), which would serialise a non-conformant body.

- 513119f: **Whole-resource endpoint generation:** `Endpoint.resource` and `Group.resource` derive an entire JSON:API endpoint set from a single resource definition — the full CRUD surface plus, for every relationship, the `related` and linkage endpoints appropriate to its kind — with `include` / `fields` / `sort` query parameters derived from the resource graph.

  ```ts
  // The whole group, fully typed, in one call:
  const articles = Group.resource(Article, {
    errors: [ArticleNotFound],
    page: Query.Page.Offset,
    // per-endpoint config overrides the top-level defaults:
    endpoints: {
      create: { errors: [TitleTaken] },
      list: { filter: { author: Schema.optionalKey(Schema.String) } },
    },
  });

  // Or get the endpoints as a tuple to compose with Group.make:
  const articles = Group.make(
    Article,
    ...Endpoint.resource(Article, { errors: [ArticleNotFound] }),
    Endpoint.list(Article, {
      name: "search",
      path: "/articles/search",
      filter: { q: Schema.String },
    }),
  );
  ```

  Defaults emit all five CRUD operations and every relationship's endpoints with `include` / `fields` / `sort` enabled; `page` and `filter` stay opt-in, and `errors` is applied uniformly. Everything is overridable, globally or per entry:

  - `endpoints` is an object keyed by operation (`get` / `list` / `create` / `update` / `delete`); each value is `true` (emit with defaults), `false` (omit), or an object configuring that endpoint (its `name` / `path` / `errors` and applicable query / `meta`), overriding the top-level defaults.
  - `relationships` is `true` (all, default) / `false` (none), or an object keyed by relationship name — each `false` to exclude, or an object to configure that relationship's endpoints. Relationships not mentioned are emitted with the defaults.
  - `meta` may be a `Schema` (overriding the document meta) or a function `(base) => schema` that _extends_ the resource's base meta rather than replacing it.

  The result is plain `HttpApiEndpoint` / `HttpApiGroup` values, so it composes with everything as before. See `Endpoint.ResourceOptions`.

  **Breaking:** several endpoint constructors are renamed, and the heterogeneous-collection constructor now takes an explicit route.

  - `Endpoint.fetch` → `Endpoint.get` (default endpoint name `"fetch"` → `"get"`).
  - `Endpoint.remove` → `Endpoint.delete` (default endpoint name `"remove"` → `"delete"`). `delete` is a reserved word, so it is re-exported from an internal implementation; `Endpoint.delete(...)` is the public name.
  - `Endpoint.fetchRelationship` → `Endpoint.getRelationship` (the relationship-linkage GET, for parity with `Endpoint.get`). The generated endpoint name `<name>Relationship` is unchanged, so handler keys and client methods are unaffected.
  - `Endpoint.search` → `Endpoint.collection`, and its `name` and `path` are now **required** (the `"search"` / `/search` defaults are removed). A polymorphic collection has no owning resource and so no conventional route; the constructor name no longer presumes "search" (it fits feeds and timelines just as well). The exported `SearchIncluded` type is renamed to `CollectionIncluded`.

  **Migration:** replace `Endpoint.fetch(R, …)` / `Endpoint.remove(R, …)` with `Endpoint.get(R, …)` / `Endpoint.delete(R, …)`, and rename the corresponding handler keys and client methods (`"fetch"` → `"get"`, `"remove"` → `"delete"`). Replace `Endpoint.fetchRelationship(R, …)` with `Endpoint.getRelationship(R, …)` — a rename of the constructor only; its `<name>Relationship` endpoint name (and thus its handler key) is unchanged. Replace `Endpoint.search([…], { … })` with `Endpoint.collection([…], { name: "search", path: "/search", … })` (the explicit `name` / `path` reproduce the old defaults), and rename any `SearchIncluded` references to `CollectionIncluded`. `Endpoint.removeRelationship` is unchanged — it matches the spec's "removing members" terminology and operates on relationship linkage, not whole resources.

- 55f8920: Add `Resource.extend` for subtyping resources, plus accessors for extracting a resource's attributes and relationships.

  ### `Resource.extend` — subtype an existing resource

  `Resource.extend(Base, type, options?)` defines a new resource that inherits the base's attributes and relationships, to which `options` adds more (keys present in `options` override the base's). JSON:API has no native subtyping, so the result is a _distinct_ resource type — its own `type` tag and branded id, with payloads and documents derived afresh — that shares the base's structure. Handy when several resources carry a common set of attributes/relationships defined once. `meta` is inherited from the base unless overridden.

  ```ts
  const Account = Resource.make("accounts", {
    attributes: {
      email: Schema.NonEmptyString,
      createdAt: Schema.DateFromString,
    },
    relationships: { organisation: Relationship.one(() => Organisation) },
  });

  // `admins` inherits email, createdAt and organisation, adding `permissions`.
  const Admin = Resource.extend(Account, "admins", {
    attributes: { permissions: Schema.Array(Schema.String) },
  });
  ```

  ### Extracting attributes and relationships
  - `Resource.attributes(resource)` returns the attribute field map the resource was defined with; spread it into another resource's `attributes` to reuse its schemas.
  - `Resource.relationships(resource)` returns the relationship descriptor record.
  - Type-level counterparts `Resource.AttributesOf<R>` and `Resource.RelationshipsOf<R>`, plus `Resource.ExtendedAttributes` / `Resource.ExtendedRelationships` describing the merge `extend` performs.

## 0.1.0

### Minor Changes

- 0ed140d: Add helpers for the JSON:API atomic operations extension (https://jsonapi.org/ext/atomic/), plus the base-spec lid (local id) concepts they build on.

  ### Lids as a first-class Resource concept
  - Every resource definition now derives `localIdentifier` (the `{ type, lid }` schema) and `lidRef(lid)` (typed local-identifier values), alongside the existing `identifier` / `ref(id)`.
  - `Resource.LocalIdentifier`, `Resource.Ref` (id-or-lid identifier union) and `Resource.RefValue` are exported from the Resource module.
  - The new standalone Lid module provides handler-side lid resolution: `Lid.make()` tracks the server-assigned ids of lid-created resources and resolves lid-based refs (including inside relationship linkage) back to typed identifiers; `Lid.UnknownLidError` signals refs to lids no operation declared.

  ### `Endpoint.operations` — the endpoint

  `Endpoint.operations([Article, Comment], options?)` builds a `POST /operations` endpoint whose payload is an `atomic:operations` document and whose success is a 200 `atomic:results` document. The operation union — resource add/update/remove, relationship operations, and lid-based refs — is derived from the resource definitions, like everything else in the library.

  Operations respect the relationship kinds: `add` operations require `one` relationships and exclude `paginated` ones (mirroring create payloads); `one` relationship updates can never be `null` while `optional` ones can; `many` and `paginated` relationships are managed through `add` / `update` / `remove` relationship operations.

  ### `Atomic` — schemas, constructors and handler helpers
  - **Discoverable operation derivation**: `Atomic.operationsFor(Article)` returns a named record of every operation derived for a resource — `add`, `update`, `remove`, and per-relationship operations by kind (`relationships.author.update`, `relationships.comments.add` / `update` / `remove`). The request document union is built from this record.
  - **Document schemas**: `RequestDocument`, `ResultDocument`, `Operations`, plus the building blocks (`AddOperation`, `UpdateOperation`, `RemoveOperation`, relationship operations, `ResourceRef` / `RelationshipRef`).
  - **Client-side constructors**: `Atomic.request`, `Atomic.add`, `Atomic.update`, `Atomic.remove`, `Atomic.updateRelationship`, `Atomic.addToRelationship`, `Atomic.removeFromRelationship` — typed operation values that encode to the spec's wire format.
  - **Handler-side helpers**: `Atomic.results` / `Atomic.result` / `Atomic.emptyResult` for building `atomic:results` documents; `Atomic.targetsResource` / `Atomic.targetsRelationship` / `Atomic.isRelationshipOperation` type guards that narrow the operation union to fully typed `data` / `ref` — dual data-first/curried APIs, so they drop into Effect's `Match` module (`Match.when(Atomic.targetsResource(Article), ...)`); `Atomic.operationPointer` for error sources.
  - **Constants**: `Atomic.EXTENSION_URI`, `Atomic.MEDIA_TYPE`, `Atomic.jsonapi`.

  ### Content negotiation: `ext` / `profile` media type parameters

  The middleware now implements JSON:API v1.1 §5 precisely: only media type parameters _other than_ `ext` / `profile` (or `ext` parameters carrying unsupported extension URIs) are rejected with 415/406. Previously any parameter was rejected, which also rejected spec-legal `profile` parameters.

  `Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })` configures the supported extension URIs; `Middleware.layer` is unchanged (no extensions). The `contentTypeIsAcceptable` / `acceptIsAcceptable` predicates accept an optional `NegotiationOptions` argument.

  Atomic operations responses carry the extension media type (`application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"`); requests are accepted with or without the `ext` parameter.

- 32dcaee: Clean-slate redesign: spec-compliant JSON:API v1.1 on Effect v4's HttpApi, by construction.

  The library is rebuilt around a resource-centric model in which a single definition is the source
  of truth and everything else — identifiers, payloads, documents, query parameters, endpoints,
  errors and middleware — is derived from it. Following the conventions of `effect` and
  `@effect/platform`, each module is exported as a namespace from the package root:

  ```ts
  import {
    ApiError,
    Atomic,
    Client,
    Document,
    Endpoint,
    Group,
    Handlers,
    Lid,
    Middleware,
    Query,
    Relationship,
    Resource,
  } from "@thomasfosterau/effect-jsonapi";
  ```

  ### Resources (`Resource.make`, `Relationship.one` / `optional` / `many` / `paginated`)
  - `Resource.make(type, { attributes, relationships?, meta? })` returns the resource object
    `Schema.Struct` augmented with derived members: `Id` (branded per-type id), `identifier`,
    `createPayload` (no `id`, optional `lid`), `updatePayload` (`id` required, partial attributes),
    `document()` and `collection()` (compound `included` union derived from the relationship graph).
  - Relationships reference other resource definitions through lazy thunks
    (`Relationship.one(() => Person)`) instead of strings — typos are compile errors and the
    relationship graph is walkable at runtime.

  ### Errors (`ApiError.make`)
  - One declaration produces a tagged Effect error class **and** its wire schema: a spec-compliant
    JSON:API error document at the declared HTTP status. No more hand-written
    `toDocument` / `fromDocument` round-trips.
  - Standard errors are predefined: `ApiError.BadRequest` (400), `ApiError.Forbidden` (403),
    `ApiError.NotAcceptable` (406), `ApiError.Conflict` (409), `ApiError.UnsupportedMediaType` (415).

  ### Endpoints & groups (`Endpoint.*`, `Group.make`)
  - `Endpoint.fetch` / `list` / `create` / `update` / `remove` adopt HttpApi's structured options
    model and bake in the JSON:API conventions: conventional paths, `application/vnd.api+json`,
    spec status codes (200/201/204), error documents, and typed query parameters.
  - `Endpoint.search` builds heterogeneous collection endpoints (search, feeds): `data` is a mixed
    array of several resource types discriminated by their `type` tags, with query features
    (`fields[TYPE]`, `include`, `sort`) derived across all of the searched resources.
    `Group.make` accepts a plain string name for groups that span resource types.
  - All constructors return plain `HttpApiEndpoint` / `HttpApiGroup` values — they compose with
    vanilla `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi`.

  ### Typed query parameters (`Query.schema`, `Query.Page`)
  - First-class schemas for the spec's query families: `include` (literal paths derived from the
    relationship graph, 2 hops), `fields[TYPE]` (closed per-type attribute sets), `sort` (typed
    fields + direction), `page[*]` (`Query.Page.Offset` / `Query.Page.Number` / `Query.Page.Cursor`
    / custom), `filter[*]` (user-defined).
  - Flat bracket-keyed strings on the wire; ergonomic nested typed values in handlers; invalid
    values become spec-compliant 400 error documents.

  ### Client-side include narrowing (`Client.narrowIncluded`)
  - Narrows a response document's `included` member to exactly the resources reachable via the
    include paths the client requested (`["author"]` → `included: ReadonlyArray<Person>`), justified
    by the spec's "MUST NOT include unrequested resource objects" rule. Pure type-level operation;
    works with `HttpApiClient` and `HttpApiTest` clients.
  - `Resource.IncludePath<R>` / `Resource.IncludedFor<R, Paths>` exported for building custom typed
    client wrappers; `Resource.make(...).ref(id)` creates typed resource-identifier values.

  ### Protocol middleware (`Middleware`)
  - Content negotiation (415/406 per JSON:API §5) and schema-error translation (validation failures
    become JSON:API 400 documents) are `HttpApiMiddleware` services attached to every endpoint —
    the api cannot be built without providing `Middleware.layer`, so compliance cannot be forgotten.

  ### Handler-side document builders (`Handlers.data`, `Handlers.collection`)
  - Build response documents from resources; `included` is deduplicated by `(type, id)` and checked
    for the spec's full-linkage rule; pagination link helpers included.

  ### Packaging
  - The worked example moved out of the published package into `examples/blog`, exercised by an
    end-to-end test suite.
  - Every public symbol of the previous surface is removed or renamed. Pinned to
    `effect@>=4.0.0-beta.84`; Node.js 20+.
