/**
 * JSON:API (v1.1) document-level schemas.
 *
 * Models the spec's primitive members (links, meta, the `jsonapi` object,
 * error objects) and the mutually-exclusive top-level document shapes:
 * data documents, collection documents, error documents and meta documents.
 *
 * Spec invariants enforced here, by construction:
 *   - A document holds exactly one of `data` / `errors` / `meta` — the
 *     document constructors each produce only one of those shapes, so mixing
 *     is unrepresentable.
 *   - `errors` is a non-empty array.
 *   - Per-context link member sets (resource / relationship / top-level) are
 *     closed to their spec-defined members.
 *
 * `meta` is free-form by spec, so it is *parameterized* (permissive default,
 * override per site) rather than hard-closed.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

/**
 * Free-form metadata: the one member set the spec genuinely leaves open.
 *
 * Used as the default wherever `meta` appears; pass a typed schema to any
 * constructor that accepts a `meta` option to tighten it.
 *
 * @since 0.1.0
 * @category schemas
 */
export const AnyMeta = Schema.Record(Schema.String, Schema.Unknown)

// ---------------------------------------------------------------------------
// Links (JSON:API 1.1 link object + per-context member sets)
// ---------------------------------------------------------------------------

/**
 * A link object, per https://jsonapi.org/format/1.1/#document-links
 *
 * @since 0.1.0
 * @category schemas
 */
export const LinkObject = Schema.Struct({
  href: Schema.String,
  rel: Schema.optionalKey(Schema.String),
  describedby: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  hreflang: Schema.optionalKey(Schema.String),
  meta: Schema.optionalKey(AnyMeta)
})

/**
 * A link: either a URL string or a {@link LinkObject}.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Link = Schema.Union([Schema.String, LinkObject])

/**
 * A resource object's `links`: the spec standardises `self`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ResourceLinks = Schema.Struct({
  self: Schema.optionalKey(Link)
})

/**
 * A relationship object's `links`: the spec standardises `self` and `related`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const RelationshipLinks = Schema.Struct({
  self: Schema.optionalKey(Link),
  related: Schema.optionalKey(Link)
})

/**
 * {@link RelationshipLinks} that also admits profile-defined members.
 *
 * @since 0.1.0
 * @category schemas
 */
export const RelationshipLinksOpen = Schema.StructWithRest(RelationshipLinks, [
  Schema.Record(Schema.String, Schema.NullOr(Link))
])

/**
 * The `links` of a paginated relationship: `related` is *required* — it is the
 * only way to reach the relationship's data — and `self` (the relationship
 * endpoint) is optional.
 *
 * Used by `Relationship.paginated`, whose relationship objects carry no inline
 * `data`; the required `related` link satisfies the spec's "a relationship
 * object holds at least one of data / links / meta" invariant by construction.
 *
 * @since 0.1.0
 * @category schemas
 */
export const PaginatedRelationshipLinks = Schema.Struct({
  self: Schema.optionalKey(Link),
  related: Link
})

/**
 * Top-level `links`: `self`/`related`/`describedby` plus the pagination
 * members (each nullable, per the spec).
 *
 * @since 0.1.0
 * @category schemas
 */
export const TopLevelLinks = Schema.Struct({
  self: Schema.optionalKey(Link),
  related: Schema.optionalKey(Link),
  describedby: Schema.optionalKey(Link),
  first: Schema.optionalKey(Schema.NullOr(Link)),
  last: Schema.optionalKey(Schema.NullOr(Link)),
  prev: Schema.optionalKey(Schema.NullOr(Link)),
  next: Schema.optionalKey(Schema.NullOr(Link))
})

// ---------------------------------------------------------------------------
// jsonapi object
// ---------------------------------------------------------------------------

/**
 * The top-level `jsonapi` object: version (closed set), extensions, profiles.
 *
 * @since 0.1.0
 * @category schemas
 */
export const JsonApiObject = Schema.Struct({
  version: Schema.optionalKey(Schema.Literals(["1.0", "1.1"])),
  ext: Schema.optionalKey(Schema.Array(Schema.String)),
  profile: Schema.optionalKey(Schema.Array(Schema.String)),
  meta: Schema.optionalKey(AnyMeta)
})

/**
 * A ready-made `jsonapi` member value advertising JSON:API v1.1.
 *
 * @since 0.1.0
 * @category constants
 */
export const v1_1: typeof JsonApiObject.Type = { version: "1.1" }

// ---------------------------------------------------------------------------
// Error objects
// ---------------------------------------------------------------------------

/**
 * An error's `source` members are alternatives — modelled as a union, not
 * three optional keys.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ErrorSource = Schema.Union([
  Schema.Struct({ pointer: Schema.String }),
  Schema.Struct({ parameter: Schema.String }),
  Schema.Struct({ header: Schema.String })
])

const errorLinks = Schema.Struct({
  about: Schema.optionalKey(Link),
  type: Schema.optionalKey(Link)
})

/**
 * A JSON:API error object with an open `code`.
 *
 * @see {@link https://jsonapi.org/format/1.1/#error-objects}
 *
 * @since 0.1.0
 * @category schemas
 */
export const ErrorObject = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  links: Schema.optionalKey(errorLinks),
  status: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(ErrorSource),
  meta: Schema.optionalKey(AnyMeta)
})

/**
 * A tightened error object with a closed `code` union.
 *
 * `code` stays optional (the spec permits omission); drop the `optionalKey`
 * wrapper in a custom schema to force presence.
 *
 * @example
 * ```ts
 * import { Document } from "@thomasfosterau/effect-jsonapi"
 *
 * const AppError = Document.ErrorObjectWithCodes(["not_found", "forbidden"])
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const ErrorObjectWithCodes = <const Codes extends ReadonlyArray<string>>(codes: Codes) =>
  Schema.Struct({
    ...ErrorObject.fields,
    code: Schema.optionalKey(Schema.Literals(codes))
  })

// ---------------------------------------------------------------------------
// Top-level documents (exactly one of data / errors / meta)
// ---------------------------------------------------------------------------

/**
 * A single-resource data document: a pure envelope whose `data` member is
 * *exactly* the schema you pass — no implicit nullability.
 *
 * Nullability is compositional, decided by the caller:
 *
 *   - `DataDocument(Article)` → `data: Article`
 *   - `DataDocument(Schema.NullOr(Article))` → `data: Article | null`
 *   - `DataDocument(Schema.OptionFromNullOr(Article))` → `data: Option<Article>`
 *
 * @since 0.1.0
 * @category models
 */
export interface DataDocument<
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
  M extends Schema.Top = typeof AnyMeta
> extends Schema.Struct<{
  readonly data: R
  readonly included: Schema.optionalKey<Schema.$Array<Included>>
  readonly links: Schema.optionalKey<typeof TopLevelLinks>
  readonly meta: Schema.optionalKey<M>
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>
}> {}

/**
 * Creates a single-resource data document schema. The document is a *pure
 * envelope*: its `data` member is exactly the schema you pass, so nullability
 * is the caller's compositional decision rather than something baked in.
 *
 *   - `DataDocument(Article)` → `data: Article` — the resource is guaranteed
 *     present (fetch-existing, create, update). A missing resource is a `404`,
 *     never `200 { data: null }`.
 *   - `DataDocument(Schema.NullOr(Article))` → `data: Article | null` — the
 *     spec's nullable primary data, for a single-resource URL that *might*
 *     correspond to a resource but currently doesn't.
 *   - `DataDocument(nullable(Article))` → `data: Option<Article>`, decoding and
 *     encoding `None ⇆ null` on the wire (see {@link nullable}).
 *
 * It generalises to linkage with no special case, e.g.
 * `DataDocument(Schema.NullOr(Comment.identifier))`.
 *
 * **Nullable data:** use `Schema.NullOr(R)` for `R | null`, or the spec-clean
 * {@link nullable} / `Schema.OptionFromNullOr(R)` for `Option<R>`. Do *not*
 * reach for effect's *structural* `Schema.Option` (`{ _tag, value }`): it
 * serialises a non-conformant body, and `DataDocument` cannot tell the two
 * codecs apart.
 *
 * `included` defaults to `Schema.Never` (no compound members permitted) so
 * compound documents are an explicit, typed decision; pass the `included` union
 * for the underlying resource's relationship graph (the `Resource.document()`
 * convenience derives it for you).
 *
 * @example
 * ```ts
 * import { Document, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 *
 * const ArticleDocument = Document.DataDocument(Article) // data: Article
 * const MaybeArticle = Document.DataDocument(Schema.NullOr(Article)) // data: Article | null
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const DataDocument = <
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
  M extends Schema.Top = typeof AnyMeta
>(
  data: R,
  options?: {
    readonly included?: Included
    readonly meta?: M
  }
): DataDocument<R, Included, M> =>
  Schema.Struct({
    data,
    included: Schema.optionalKey(Schema.Array((options?.included ?? Schema.Never) as Included)),
    links: Schema.optionalKey(TopLevelLinks),
    meta: Schema.optionalKey((options?.meta ?? AnyMeta) as M),
    jsonapi: Schema.optionalKey(JsonApiObject)
  })

/**
 * The blessed nullable codec for {@link DataDocument}: `nullable(R)` is
 * `Schema.OptionFromNullOr(R)`, so a document built from it has
 * `data: Option<R>` that round-trips JSON:API's `null` primary data
 * (`None ⇆ null`, `Some(r) ⇆ r`).
 *
 * Prefer this to effect's *structural* `Schema.Option` (`{ _tag, value }`),
 * which would serialise a non-conformant body — `DataDocument` cannot tell the
 * two codecs apart, so the choice is yours to get right. For a plain
 * `data: R | null` (no `Option` wrapper), pass `Schema.NullOr(R)` instead.
 *
 * @example
 * ```ts
 * import { Document, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 *
 * // data: Option<Article>, ⇆ null on the wire
 * const MaybeArticle = Document.DataDocument(Document.nullable(Article))
 * ```
 *
 * @since 0.2.0
 * @category constructors
 */
export const nullable = Schema.OptionFromNullOr

/**
 * A collection document: `data` is an array of resources (possibly empty).
 *
 * @since 0.1.0
 * @category models
 */
export interface CollectionDocument<
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
  M extends Schema.Top = typeof AnyMeta
> extends Schema.Struct<{
  readonly data: Schema.$Array<R>
  readonly included: Schema.optionalKey<Schema.$Array<Included>>
  readonly links: Schema.optionalKey<typeof TopLevelLinks>
  readonly meta: Schema.optionalKey<M>
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>
}> {}

/**
 * Creates a collection document schema: `data` is an array of resources
 * (possibly empty).
 *
 * @example
 * ```ts
 * import { Document, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 *
 * const ArticleCollection = Document.CollectionDocument(Article)
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const CollectionDocument = <
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
  M extends Schema.Top = typeof AnyMeta
>(
  resource: R,
  options?: {
    readonly included?: Included
    readonly meta?: M
  }
): CollectionDocument<R, Included, M> =>
  Schema.Struct({
    data: Schema.Array(resource),
    included: Schema.optionalKey(Schema.Array((options?.included ?? Schema.Never) as Included)),
    links: Schema.optionalKey(TopLevelLinks),
    meta: Schema.optionalKey((options?.meta ?? AnyMeta) as M),
    jsonapi: Schema.optionalKey(JsonApiObject)
  })

/**
 * A relationship-linkage document: the top-level document served by
 * relationship endpoints (`GET /articles/1/relationships/comments`).
 *
 * `data` is resource linkage — one identifier, `identifier | null`, or an
 * identifier array, depending on the relationship kind — never full resource
 * objects.
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-relationships}
 *
 * @since 0.1.0
 * @category models
 */
export interface LinkageDocument<D extends Schema.Top, M extends Schema.Top = typeof AnyMeta> extends Schema.Struct<{
  readonly data: D
  readonly links: Schema.optionalKey<typeof TopLevelLinks>
  readonly meta: Schema.optionalKey<M>
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>
}> {}

/**
 * Creates a relationship-linkage document schema. Pass the linkage shape as
 * `data`: an identifier schema, `Schema.NullOr(identifier)` or
 * `Schema.Array(identifier)`.
 *
 * @example
 * ```ts
 * import { Document, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Person = Resource.make("people", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * // Linkage document for a to-one relationship endpoint.
 * const AuthorLinkage = Document.LinkageDocument(Schema.NullOr(Person.identifier))
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const LinkageDocument = <D extends Schema.Top, M extends Schema.Top = typeof AnyMeta>(
  data: D,
  options?: {
    readonly meta?: M
  }
): LinkageDocument<D, M> =>
  Schema.Struct({
    data,
    links: Schema.optionalKey(TopLevelLinks),
    meta: Schema.optionalKey((options?.meta ?? AnyMeta) as M),
    jsonapi: Schema.optionalKey(JsonApiObject)
  })

/**
 * An error document: a non-empty `errors` array, never `data`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ErrorDocument<E extends Schema.Top = typeof ErrorObject> extends Schema.Struct<{
  readonly errors: Schema.$Array<E>
  readonly links: Schema.optionalKey<typeof TopLevelLinks>
  readonly meta: Schema.optionalKey<typeof AnyMeta>
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>
}> {}

/**
 * Creates an error document schema: a non-empty `errors` array, never `data`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const ErrorDocument = <E extends Schema.Top = typeof ErrorObject>(error?: E): ErrorDocument<E> =>
  Schema.Struct({
    errors: Schema.Array((error ?? ErrorObject) as E).check(Schema.isMinLength(1)),
    links: Schema.optionalKey(TopLevelLinks),
    meta: Schema.optionalKey(AnyMeta),
    jsonapi: Schema.optionalKey(JsonApiObject)
  })

/**
 * A meta-only document.
 *
 * @since 0.1.0
 * @category models
 */
export interface MetaDocument<M extends Schema.Top = typeof AnyMeta> extends Schema.Struct<{
  readonly meta: M
  readonly links: Schema.optionalKey<typeof TopLevelLinks>
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>
}> {}

/**
 * Creates a meta-only document schema.
 *
 * @since 0.1.0
 * @category constructors
 */
export const MetaDocument = <M extends Schema.Top = typeof AnyMeta>(meta?: M): MetaDocument<M> =>
  Schema.Struct({
    meta: (meta ?? AnyMeta) as M,
    links: Schema.optionalKey(TopLevelLinks),
    jsonapi: Schema.optionalKey(JsonApiObject)
  })

/**
 * The full top-level document union: exactly one of data / errors / meta.
 *
 * @since 0.1.0
 * @category models
 */
export interface Document<
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
  M extends Schema.Top = typeof AnyMeta,
  E extends Schema.Top = typeof ErrorObject
> extends Schema.Union<readonly [DataDocument<R, Included, M>, ErrorDocument<E>, MetaDocument<M>]> {}

/**
 * Creates the full top-level document union schema: exactly one of data /
 * errors / meta.
 *
 * @example
 * ```ts
 * import { Document, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 *
 * // A schema accepting a data, error, or meta document for `Article`.
 * const ArticleResponse = Document.Document(Article)
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Document = <
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
  M extends Schema.Top = typeof AnyMeta,
  E extends Schema.Top = typeof ErrorObject
>(
  resource: R,
  options?: {
    readonly included?: Included
    readonly meta?: M
    readonly error?: E
  }
): Document<R, Included, M, E> =>
  Schema.Union([
    DataDocument(resource, { included: options?.included, meta: options?.meta }),
    ErrorDocument(options?.error),
    MetaDocument(options?.meta)
  ])
