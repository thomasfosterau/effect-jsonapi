---
"effect-jsonapi": major
---

Rewrite on Effect v4 (beta).

- **Effect v4 only.** Pinned to `effect@^4.0.0-beta.70` (tested against
  `4.0.0-beta.70`). All imports come from `effect` or `effect/unstable/*`. The
  v3 surface (`@effect/schema`, `@effect/platform`) is no longer supported.
- **New two-layer architecture.**
  - `JsonApi.ts` — schema-only modelling: branded `ResourceId`, tagged
    `ResourceIdentifier`, `toOne` / `toMany` relationships, `JsonApiResource`,
    closed `JsonApiError(codes)`, `DataDocument`, `CollectionDocument`,
    `ErrorDocument`, `MetaDocument`, `JsonApiDocument`. Tighter envelopes than
    the v3 surface: per-context links, parameterized meta, discriminated
    `included` union, closed error-code unions.
  - `JsonApiHttp.ts` — thin wrapper over `HttpApiEndpoint` that bakes in the
    `application/vnd.api+json` media type, document wrapping, default status
    codes (201 for create, 204 for delete), and the mandatory JSON:API error
    responses (400/406/415). Layer 1 schema combinators preserve inference;
    Layer 2 verb constructors (`get`, `list`, `create`, `update`, `delete`)
    bake in the conventions plus the standard errors.
  - `JsonApiMiddleware.ts` — `HttpApiMiddleware` enforcing JSON:API §5 content
    negotiation: parameterised JSON:API `Content-Type` → 415; unacceptable
    `Accept` → 406. Fails with the same `UnsupportedMediaType` / `NotAcceptable`
    tagged errors that `StandardErrors` already declares on every endpoint.
- **`CollectionDocument` / `JsonApiEndpoint.list`.** For list endpoints, a
  strict `data: ReadonlyArray<resource>` is now available; `DataDocument` /
  `JsonApiEndpoint.get` remain the union (`resource | resource[] | null`) for
  endpoints that legitimately serve any of those.
- **Worked example.** `Article` / `Person` / `Comment` resources plus an
  `Api` with `getArticle` / `createArticle` / `deleteArticle` endpoints,
  backed by in-memory handlers (no `declare const` stubs). An HTTP round-trip
  test exercises the full request/response pipeline through the in-memory
  `HttpApiTest` client.
- **Date attributes are wire-shaped.** `Article.attributes.createdAt` now uses
  `Schema.DateFromString` so JSON wire payloads round-trip through the typed
  `Date` instance.

**BREAKING CHANGES.** Every public symbol from the v3 surface
(`ResourceObjectWithId/Lid`, v3 `Relationship`, v3 `Document`,
`ResourceIdentifierWithLid`) is removed. The Effect peer dependency is bumped
to `>=4.0.0-beta.70`. Node.js 20+ required (unchanged from the previous
major).

### Drift notes (v4 beta API)

Adjustments made between the draft modules and `effect@4.0.0-beta.70`:

- `HttpApiEndpoint.del` is exported as `delete`, not `del`. The Layer-2
  constructor calls `HttpApiEndpoint.delete(...)`.
- Layer-2 verb constructors had to thread the `Params` / `Query` generics
  (`extends Schema.Struct.Fields = never`) so the loose `Schema.Struct.Fields`
  shape doesn't erase `params.id` to `unknown` at handler sites.
- `Schema.tag(...)`'s constructor default only autofills when the literal is
  the direct field of a `.make(...)` call. Inside *nested* relationship
  literals, the `type` must be supplied explicitly.
- `Schema.Date` is `instanceOf<globalThis.Date>` — i.e. its Encoded form is
  also a `Date`. For JSON round-tripping we use `Schema.DateFromString` on
  `Article.attributes.createdAt`.
- `HttpApiTest.groups` requires a `Scope` in context; wrap call sites with
  `Effect.scoped`.
- `Effect.void` is the void Effect value (used as a 204 handler return);
  `Effect.asVoid` is the combinator.
- Relative imports use `.js` extensions (NodeNext module resolution) even
  though the source files are `.ts`.
- The middleware's behaviour is exercised by directly unit-testing the
  predicate functions (`contentTypeIsAcceptable`, `acceptIsAcceptable`); the
  in-memory `HttpApiTest` client does not expose a per-request header hook to
  validate the wired-up middleware end-to-end. The middleware itself is a
  thin shell over those predicates.

### Deliberate, reversible choices kept from the draft

- Relationship `data` is required. Servers that may send only `links`/`meta`
  should wrap `data` in `Schema.optionalKey(...)` per-resource.
- Error `code` is optional within a closed `Literals` union. Drop the
  `optionalKey` wrapper to require it.
- `meta` is parameterized (defaults to `AnyMeta` = `Record<string, unknown>`)
  rather than closed.
- `JsonApiEndpoint.get` keeps the union `resource | resource[] | null` for
  flexibility. `JsonApiEndpoint.list` is the strict-array constructor for
  endpoints that return a collection.
- The Layer-2 `params` / `query` are threaded as generics; the success type
  and request type stay precise enough for typed handlers without
  reproducing `HttpApiEndpoint`'s full dual overloads. For endpoints that
  need finer precision than these defaults allow, drop to the raw
  `HttpApiEndpoint.*` constructor with the Layer-1 `jsonApi.*` combinators.
