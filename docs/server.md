# The server skeleton

Three applications built on this package each grew the same two thousand lines on top of it: an error catalogue and the seam that turns a failure into an error document, a content-negotiation verdict for an api that shares its URLs with rendered pages, a document assembler that stamps per-viewer `meta` and stringifies links, a handler factory over "the operations", and a registry that checks every family against its group at module init. That scaffolding lives here now, as the modules below, an opt-in layer over the core published at `@thomasfosterau/effect-jsonapi/skeleton` (`Assemble`, `ResourceHandlers`, `Registry`, `FlatQuery`; `ServerErrors`, `Negotiation` and `Group.flat` stay where they are). Each is optional — an api built from `Group.make` and `HttpApiBuilder` directly never meets them — and each is generic in what an application owns: its viewer, its transaction boundary, its cache, its database's errors.

## The flat contract

A _flat_ contract is one whose list inputs are one struct the rest of the application consumes directly — `{ limit, offset, status, sort }` — and whose write payloads are flat command inputs rather than the JSON:API envelope. `FlatQuery` is the grammar such a struct is built from (bounded pagination with decoding defaults, the `?sort=` string in both wire spellings, a `filter[ids]` list, a slug attribute), `Query.flatList` puts it on the wire, and `Group.flat` / `Group.flatReadOnly` derive the standard endpoint set from it:

```ts
import { Group, Include, Resource } from "@thomasfosterau/effect-jsonapi";
import { FlatQuery } from "@thomasfosterau/effect-jsonapi/skeleton";
import { Schema } from "effect";

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

## The error seam

`ServerErrors` holds the catalogue an operation fails with (`NotFound`, `Unauthorized`, `Forbidden`, `Redirect`, `HttpError`, `ValidationFailure`), the `JsonapiError` carrier for a one-off, and `fromTaggedError`, which maps any of them — and any `ApiError.make` class, `ApiError.Conflict` and the package's own include / sort errors included — to its error document. `respond` wraps a handler with it:

```ts
import { Effect, Option } from "effect";
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

## The negotiation verdict

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

A host that negotiates with `@thomasfosterau/effect-ext/Negotiate`'s media-type-agnostic `negotiateRepresentation` takes the JSON:API half from here: `Negotiation.representation({ extensions, servesPath })` is the JSON:API `Representation` (JSON:API §5: only `ext` / `profile`, every `ext` URI declared), and `Negotiation.toApiError(negotiation)` turns that negotiator's refusal of it into `ApiError.NotAcceptable` (406) or `ApiError.UnsupportedMediaType` (415):

```ts
const jsonApi = Negotiation.representation({
  extensions: [Atomic.EXTENSION_URI],
  servesPath: isApiPath,
});
// negotiateRepresentation(request, { accept: [markdown, jsonApi], contentType: [jsonApi] })
Negotiation.toApiError(negotiation); // Option<ApiError.NotAcceptable | ApiError.UnsupportedMediaType>
```

## The assembler, the handlers and the registry

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

To give the collection its own `self` link, pass `self` (its absolute URL) and, optionally, `query` — the request's canonical pairs (`Query.canonicalPairs(listQuery)(query)`), serialised onto `self` the way `Assemble.collection` serialises them onto its pagination links. The document then carries `links: { self }` and still no `meta`; the return type follows the `self` you pass (`links` required whenever you pass one), and `query` is a type error without `self`. A `self` you may not have is passed only when it is defined: the option takes no explicit `undefined`. With no `self` the output is exactly as above:

```ts
const document = Assemble.unpaginatedCollection(colours, {
  self: "https://example.test/colours",
  query: Query.canonicalPairs(listQuery)(query),
});
// Effect<UnpaginatedCollectionDocument<Colour, string>, …>
// succeeds with { data: [...], links: { self: "https://example.test/colours?sort=name" }, jsonapi: … }
```

Document-level metadata that isn't page math (a generation timestamp, a cache hint, an application-specific summary) goes in `meta`, which the document carries as given. The return type follows it the way it follows `self`: `meta` of the type you pass, and no `meta` member at all without it (pass it only when it is defined, as for `self`). An object literal keeps its literal type (`meta` is inferred `const`, as on `Handlers.collection`, since the document emits that very value), and a value typed by an `interface` with no index signature is rejected, as `Handlers.collection` rejects it: spread it (`{ ...stamp }`) or use a `type` alias. `meta.totalCount` gets no special treatment: it is emitted verbatim, and with `self` makes the document structurally assignable to `CollectionDocument`. A collection whose total matters is a page, and goes through `Assemble.collection`:

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
import { Assemble, Registry, ResourceHandlers } from "@thomasfosterau/effect-jsonapi/skeleton"
import * as Option from "effect/Option"

const peopleFamily = {
  group: "people",
  handlers: ResourceHandlers.make({
    segment: "people",
    listQuery: peopleListQuery,                    // the family's own list query, for the links
    linkBase,                                      // Effect<string>: the absolute origin
    viewer,                                        // Effect<Option<User>>: the request's viewer
    capabilities: Assemble.roleCapabilities((user) => Option.exists(user, (u) => u.role === "admin")),
    transact,                                      // the boundary every write runs inside
    cache,                                         // read-through on get, write-through on writes
    include: { includable: PERSON_INCLUDE.paths, targets },
    ops: { list, get, create, update, delete },    // the application's Effect-native operations
  }),
} satisfies Registry.FamilyFor<typeof peopleGroup>  // every handler's success channel checked
                                                    // against its endpoint's declared document

const { handler } = Registry.webHandler(Api, [peopleFamily, articlesFamily /* built the same way */], {
  respond: boundary,
})
// (request: Request, context: Context<User | Database | …>) => Promise<Response>
```

Every write runs its operation inside `transact`, re-reads the row as the writer and writes it through the cache. The commit and the cache step can't be separated by an interrupt, and a failed re-read evicts the cached entry before its failure propagates, so a write that hides the row from its own writer (a public row made private by a writer who can't read private rows) can't leave the old public resource in the cache.

A committed write the writer can no longer read would otherwise answer 404, and a client retrying a "failed" create duplicates it. `hiddenWrite` names the re-read failures that mean "hidden", and the handler answers those with the resource's identifier instead: `201` / `200` with `{ data: { type, id, meta: { version } } }` and no attributes (attributes and relationships are optional members of a resource object), `version` coming from the operation's write result when it reports one. The group must declare that document, with `hiddenWrites: true`; without it the writes declare the full document alone, and `Registry.FamilyFor` rejects a handler set that could answer anything else:

```ts
import { Group } from "@thomasfosterau/effect-jsonapi";
import { ResourceHandlers } from "@thomasfosterau/effect-jsonapi/skeleton";
import { Predicate } from "effect";

const { group } = Group.flat({
  resource: Person,
  list: ListPeople,
  create,
  update,
  hiddenWrites: true,
});
// POST /people → 201 { data: Person } | { data: { type: "people", id, meta?: { version } } }

ResourceHandlers.make({
  // …as above, with `create` / `update` answering `{ id, version? }`
  hiddenWrite: { type: "people", when: (error) => Predicate.isTagged(error, "NotFound") },
});
```

The identifier document carries no `links.self`, so its `201` has no `Location`. Its resource object is closed: a full document whose attributes fail the resource's schema is not answered as the identifier document instead (it is a 500, as any response that fails to encode is), and a client decodes it as a failure, not as an identifier. A re-read cause is "hidden" only when every failure in it is one `when` accepts. `version` may be of any type: a string or a finite number is echoed as is, a `bigint` as its decimal string, and anything else is left out of `meta`.

Without a `transact`, each operation is its own autocommitted write: an interrupt that lands after it commits but before it returns is seen as a write that never succeeded, and evicts nothing. Supply a `transact` where that window matters.
