# Adopting the 0.14 surfaces in an existing api

The consuming applications (`thomasfosterau/website`, the foundation; `gardeneria`; `preferenceflow`) adopted this package at `Resource.make`, `Document.*`, `Group.resource`, `Handlers.data` / `collection` / `offsetPaginationLinks` / `buildIncluded`, `Middleware.layerHostNegotiated`, `ApiError.Conflict` and `Query.bracketPageKeys` / `canonicalPairs` — and stopped there. Roughly 500 lines per application re-implement what 0.14 ships. This guide walks each of those re-implementations, as they stand in website's files, to the package surface that replaces it: the code on the left is website's; the code on the right compiles and runs against this package ([`test/guides/adopting-0.14.test.ts`](../../test/guides/adopting-0.14.test.ts) executes every "after" snippet, so the guide cannot drift from the API).

Adopt in the order below. Each step is independently shippable and each leaves the wire unchanged — a rejected include path answers the same 400 with the same `meta`, a compound document carries the same `included` in the same order, an error message reads the same `detail` — so an adoption PR can be checked against the application's contract snapshot and its existing tests rather than against new ones.

| Application code | Package surface |
| --- | --- |
| [1.](#1-the-include-surface-declared-once) `packages/api/src/resource.ts` `IncludeSpec` / `nested` / `includedUnion` / `includablePaths` | `Include.make` / `Include.nested` / `.paths` / `.included` |
| [2.](#2-the-include-walk) `apps/api/src/document.ts` `planIncludes` + the level walk, `include-targets.ts` `makeIncludeBatchResolver` / `includedForPage` | `Handlers.resolveIncluded(data, include, targets, { concurrency, depth })`, `Query.validateIncludePaths` |
| [3.](#3-the-per-resource-pass) `document.ts` `projectFields`, `withViewerMeta` / `CapabilitiesHook` | `onResource: Handlers.compose(Handlers.project(fields), Handlers.withMeta(…))` |
| [4.](#4-reading-error-documents-on-the-client) `packages/api/src/jsonapi.ts` client `ApiError`, `errorDocumentMessage`, `decodeErrorBody` | `Client.errorDocument`, `Client.errorMessage`, `Client.decodeErrorDocument` (and `Client.narrowIncluded`) |
| [5.](#5-content-negotiation) `packages/api/src/negotiate.ts` Accept / Content-Type q-value parsing with the `ext` / `profile` allow-list | `Middleware.negotiate`, `Middleware.contentTypeIsAcceptable`, `Middleware.acceptIsAcceptable` |

The two application-side needs the survey named — a rejected `?include=` must publish `meta.includablePaths` (website #1623), and a per-surface `MAX_INCLUDE_DEPTH = 3` — are covered in [step 2](#2-the-include-walk): the first is a package change that shipped with this guide, the second is `resolveIncluded`'s `depth` option, whose default is already 3.

## 1. The include surface, declared once

**Before** — `packages/api/src/resource.ts:335-452` declares a spec type and three projections over it, and each group spells the three out by hand:

```ts
// packages/api/src/resource.ts
export type IncludeSpec = Readonly<Record<string, Schema.Top | IncludeBranch>>;
export const nested = (target: Schema.Top, include: IncludeSpec): IncludeBranch => ({
  _tag: "IncludeBranch",
  target,
  include,
});
export const includedUnion = (spec: IncludeSpec): Schema.Top => {
  /* flatten, dedupe by instance, throw on an empty spec */
};
export const includablePaths = (spec: IncludeSpec): readonly string[] => {
  /* walk, `${prefix}.${key}` */
};

// packages/api/src/groups/bibliographies.ts
export const BIBLIOGRAPHY_INCLUDE: IncludeSpec = {
  entries: nested(BibliographyEntry, { bibliography: Bibliography }),
};
export const BIBLIOGRAPHY_INCLUDABLE = includablePaths(BIBLIOGRAPHY_INCLUDE);

HttpApiEndpoint.get("list", "/", {
  query: includableListQuery(PaginationInput),
  success: CollectionDocument(Bibliography, { included: includedUnion(BIBLIOGRAPHY_INCLUDE) }),
});
```

**After** — `Include.make` is the same nested declaration, typed against the resource's relationship graph (an unknown key, a `paginated` relationship or a wrong target is a compile error and a build-time throw), and the whitelist, the `included` union and the advertised parameter are all projections of it:

```ts
import { Include } from "@thomasfosterau/effect-jsonapi";

const BIBLIOGRAPHY_INCLUDE = Include.make(Bibliography, {
  entries: Include.nested(BibliographyEntry, { bibliography: Bibliography }),
});

BIBLIOGRAPHY_INCLUDE.paths; // ["entries", "entries.bibliography"] — typed literals, walk order
BIBLIOGRAPHY_INCLUDE.included; // Schema.Union([BibliographyEntry, Bibliography])
BIBLIOGRAPHY_INCLUDE.has("entries.nope"); // false — the whole dotted path is matched

// One option, all three — on `get`, on `list`, or on the whole generated group:
Group.resource(Bibliography, { include: BIBLIOGRAPHY_INCLUDE, page: Query.Page.Offset });
```

A pair that references each other — a bibliography's `entries` and an entry's `bibliography` — is a cycle, and needs the one-interface-per-resource annotation the README's [mutually recursive resources](../../README.md#mutually-recursive-resources) section describes; the test file shows it applied to this pair.

What changes for a family that hand-widened its union ("the document's union is wider than the spec's own", the note in `bibliographies.ts`): nothing to spell any more — `.included` carries every depth by construction, which is the drift the hand-widening papered over.

**Polymorphic keys.** `books.ts` declares `publisher: ContributorAgent` where `ContributorAgent = Schema.Union([Person, Organisation])`, and `contributorArm(kind)` nests `{ contributor: ContributorAgent }` under each contribution kind. An `Include.make` spec value is a resource definition, checked against the relationship's declared target, so a polymorphic key is declared the way the package models polymorphism: the relationship targets a `Resource.family` (`Relationship.one(() => ContributorAgent)` with `ContributorAgent = Resource.family(Agent, [Person, Organisation])`) and the spec names that family — see the README's [polymorphic families](../../README.md#polymorphic-families-heterogeneous-supertypes). `.included` then flattens the family's members into the union exactly as `includedUnion`'s `flatten` did.

## 2. The include walk

**Before** — `apps/api/src/document.ts:630-887` validates the requested paths (`planIncludes`: split, depth-cap, whole-path whitelist, throw `UnsupportedIncludeError` carrying `allowed`), then walks them a level at a time (`unseenLevelRefs` / `attachLevel` / `walkSegments`) against a resolver; `include-targets.ts` supplies the resolver from the one registry of batched loaders (`INCLUDE_TARGETS`, `loadRefs`, `makeIncludeBatchResolver`) and the collection variant `includedForPage`; `respond.ts` turns the thrown error into the 400 with `meta.includablePaths`. Roughly 350 lines, and the seven properties `document.ts` documents (batched per level, `(type, id)` dedup, walk-order emission, cycle-safe, depth-capped, unresolvable dropped, `undefined` when unasked) are the properties `Handlers.resolveIncluded` guarantees.

```ts
// apps/api/src/groups/bibliographies.ts
const included = yield * includedForPage(bibliographies, input.include, BIBLIOGRAPHY_INCLUDABLE);
return assembleCollection(
  bibliographies,
  { totalCount, offset, limit, baseUrl, query },
  {
    viewer,
    ...(included === undefined ? {} : { included }),
  },
);

// and for a single resource
const document = assembleResource(bibliography, {
  viewer,
  ...(input.include === undefined ? {} : { include: input.include }),
  includable: BIBLIOGRAPHY_INCLUDABLE,
  loadResource: makeIncludeResolver(context), // per ref
  // or loadResources: makeIncludeBatchResolver(context) — batched per level
});
```

**After** — one registry keyed by JSON:API `type` (each entry is the family's own batched `getMany`, viewer-gated exactly as its `get` is), one call for a resource or a whole page:

```ts
import { Handlers } from "@thomasfosterau/effect-jsonapi";

// The one registry — website's INCLUDE_TARGETS. Declare it with `satisfies` so
// each loader's resource / error / service types stay visible to the walk.
const targets = {
  bibliographies: (ids) => ops.getManyBibliographies(ids),
  "bibliography-entries": (ids) => ops.getManyBibliographyEntries(ids),
  // …every type a relationship can point at
} satisfies Handlers.IncludeTargets;

// A page or a single resource — same call, same properties.
const included =
  yield *
  Handlers.resolveIncluded(bibliographies, query.include, targets, {
    concurrency: 4, // website's INCLUDE_CONCURRENCY — bounded fan-out across target types
    depth: 3, // website's MAX_INCLUDE_DEPTH — the package default, spelled out
  });
return Handlers.collection(bibliographies, { included, links, meta: { totalCount } });
```

`resolveIncluded` returns `undefined` when nothing was asked for and the builders omit the member for it, so the `included === undefined ? {} : { included }` dance disappears. The walk is an `Effect` with the loaders' own error and service channels — no `Effect.runPromiseWith(context)` bridge, no `Effect.promise(() => Promise.resolve(document))` normalisation (#1944), because nothing here is a `Promise`.

**The 400 for a rejected path.** Two cases, both carrying the whole legal set as `meta.includablePaths` — the contract `UnsupportedIncludeError.allowed` existed for (#1623):

- A path outside the declared surface never reaches a handler. `Endpoint.get(Bibliography, { include: BIBLIOGRAPHY_INCLUDE })` rejects `?include=entries.nope` at decode time, and `Middleware.schemaErrorDocument` renders it as `{ status: "400", source: { parameter: "include" }, meta: { includablePaths: ["entries", "entries.bibliography"] } }`. As of this guide the literal schema publishes the set, so the 400 carries it — previously it carried the `source` alone. `?sort=` does the same with `meta.sortableFields`.
- A handler that validates paths at runtime (a `related` endpoint resolving one level, a family whose allow-list is data) calls `Query.validateIncludePaths(paths, { includable: surface.paths, maxDepth: 3 })` and fails with `ApiError.UnsupportedIncludePath` / `UnsupportedIncludeDepth`; both encode to the same document (`source: { parameter: "include" }`, `meta.includablePaths`, `meta.maxDepth`).

```ts
const rejected =
  yield *
  Query.validateIncludePaths(["entries.nope"], {
    includable: BIBLIOGRAPHY_INCLUDE.paths,
    maxDepth: 3,
  }).pipe(Effect.flip);
ApiError.toDocument(rejected).errors[0].meta;
// → { path: "entries.nope", includablePaths: ["entries", "entries.bibliography"] }
```

`respond.ts`'s `UnsupportedIncludeError` arm and `UnsupportedIncludeError` itself go; `MAX_INCLUDE_DEPTH` becomes the `depth` option, per call site rather than per module.

## 3. The per-resource pass

**Before** — `document.ts:376-391` projects sparse fieldsets over every assembled resource (although no endpoint advertises `?fields[]`), and `withViewerMeta` merges the model's `meta` with what a `CapabilitiesHook` computes for the viewer, dropping the member when the merge is empty. Both run on the primary resource, on every `included` member and on a relationship document's parent, as three separate call sites.

```ts
// apps/api/src/document.ts
const enriched = stringifyLinks(withViewerMeta(resource, options.viewer, options.capabilities));
const projected = projectFields(enriched, options.fields);
// … and again over `included`, and again in assembleRelationship
```

**After** — one `onResource` hook the builders apply once per resource in every slot, so a document cannot describe one type two ways depending on where it landed:

```ts
import { Handlers } from "@thomasfosterau/effect-jsonapi";

// website's `defaultCapabilities`, as a transform
const capabilities = (viewer: Viewer | null) =>
  Handlers.withMeta(() => ({ canEdit: canWrite(viewer), canDelete: canWrite(viewer) }));

const document = Handlers.data(bibliography, {
  included,
  onResource: Handlers.compose(Handlers.project(query.fields), capabilities(viewer)),
});
```

`Handlers.project` keeps every field for a type with no requested set (the spec's default) and projects `attributes` only, so `relationships` / `links` / `meta` survive; `Handlers.withMeta` merges over the resource's declared `meta` and omits the member when the computation yields nothing — `noCapabilities` is `Handlers.withMeta(() => undefined)`. Both are typed: `document.data.attributes` narrows to the projected keys and `document.data.meta` to the computed members.

What stays application-side: `stringifyLinks` (`URL` → string on `links.self` / `links.related`) and `toWireSafeResource` (`Date` → ISO for open schemas). Those belong to the wire-type layer effect-jsonapi#172 extracts (`Document.wire`); until then keep them, applied before the builder.

## 4. Reading error documents on the client

**Before** — `packages/api/src/jsonapi.ts:341-381` carries an `ApiError` class (`status`, `message`, `document | undefined`), `errorDocumentMessage` (first `detail`, else `title`, else a constant) and `decodeErrorBody` (a best-effort decode returning `undefined`); `apps/web/src/lib/api/transport.ts` bridges an `HttpClientError` into it with a `try` / `catch` around `response.json`.

```ts
// apps/web/src/lib/api/transport.ts
const raiseClientError = async (error: unknown): Promise<never> => {
  if (HttpClientError.isHttpClientError(error) && error.response !== undefined) {
    let document: Option.Option<ErrorDocument>;
    try {
      const body = await Effect.runPromise(error.response.json);
      document = Option.fromUndefinedOr(decodeErrorBody(body));
    } catch {
      document = Option.none();
    }
    throw apiErrorFrom(error.response.status, document);
  }
  throw error;
};
```

**After** — `Client.errorDocument(cause)` reads the body off an `HttpClientError` and decodes it through the same seam `Client.decodeErrorDocument(body)` exposes for a façade that never holds a response; neither throws, neither fails:

```ts
import { Client } from "@thomasfosterau/effect-jsonapi";

const describe = (cause: unknown) =>
  Effect.map(Client.errorDocument(cause), (document) =>
    Option.match(document, {
      onNone: () => Client.DEFAULT_ERROR_MESSAGE,
      onSome: Client.errorMessage, // first `detail`, else `title`, else the constant
    }),
  );
```

`decodeErrorBody` → `Client.decodeErrorDocument` (an `Option` rather than `undefined`, which is what both transports were already lifting it to); `errorDocumentMessage` → `Client.errorMessage`; the `ApiError` class itself — the status-plus-message the SvelteKit loads consume — stays application-side until effect-jsonapi#174's `Client.make` extension lands. Where a load reads a typed document's `included`, `Client.narrowIncluded(Resource, include)` narrows it to the requested paths' types at no runtime cost.

## 5. Content negotiation

**Before** — `packages/api/src/negotiate.ts:232-324` parses `Accept` and `Content-Type` (split on `;`, `q=` as a weight, the `ext` / `profile` allow-list, "every instance parameterised → 406") to feed the read / write verdicts.

**After** — the parser is the package's; only the verdict that uses it stays:

```ts
import { Middleware } from "@thomasfosterau/effect-jsonapi";

Middleware.acceptIsAcceptable('application/vnd.api+json;charset="utf-8"'); // false → 406
Middleware.acceptIsAcceptable("application/vnd.api+json;q=0.8, text/html"); // true — `q` is a weight
Middleware.contentTypeIsAcceptable('application/vnd.api+json;ext="https://x"', {
  extensions: ["https://x"],
}); // true

// Or the whole §5 answer for a hook that owns the request: the ApiError to
// render (415 / 406), or `undefined` when the request is acceptable.
const error = Middleware.negotiate({
  contentType: request.headers.get("content-type") ?? undefined,
  accept: request.headers.get("accept") ?? undefined,
});
if (error !== undefined)
  return new Response(JSON.stringify(ApiError.toDocument(error)), {
    status: Number(ApiError.toDocument(error).errors[0]?.status),
  });
```

`splitMediaType`, `paramKey`, `qualityOf`, `isCleanAccept` and the `ALLOWED_PARAMS` set go. What stays in `negotiate.ts` is the **representation verdict** — whether a request on this origin is a JSON:API dispatch, an HTML page or a Markdown page (`analyzeAccept`'s `wins`, `isApiPath`, `isMarkdownPath`, `requestForRouter`, `jsonApiErrorResponse`) — which the package does not answer today; it is item 3 of effect-jsonapi#172 (`Negotiation`), and the one gap this guide found that is not a documentation gap.

## After all five

Per application, what remains of the surveyed files is the wire-type layer (`Wire<T>` / `wireResource`), the assembler's envelope options (`viewer`, `capabilities`, `PaginationOptions`), the resource-handler factory and the registry / router — the server skeleton effect-jsonapi#172 extracts next. Adopting these five first is what makes that skeleton thin.
