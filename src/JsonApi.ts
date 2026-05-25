// JSON:API (v1.1) modelling for Effect v4 Schema — tightened envelope types.
//
// Verified against effect@4.0.0-beta.70.
// Single import surface: `effect`.
//
// Tightening strategy:
//   - `meta` is free-form by spec, so it is *parameterized* (permissive default,
//     override per site) rather than hard-closed.
//   - `links` and `jsonapi.version` have spec-defined member sets, so they are
//     modelled as closed structs (with an extensible variant available).
//   - `included` is a *discriminated* union keyed on the `type` tag.
//   - Constraints that should narrow the type use unions / required keys;
//     `makeFilter` is reserved for rules that cannot be expressed structurally.
import { Schema, Struct } from "effect"

// ---------------------------------------------------------------------------
// Free-form meta (the one genuinely open member set)
// ---------------------------------------------------------------------------

export const AnyMeta = Schema.Record(Schema.String, Schema.Unknown)

// ---------------------------------------------------------------------------
// Links (JSON:API 1.1 link object + per-context member sets)
// ---------------------------------------------------------------------------

export const LinkObject = Schema.Struct({
  href: Schema.String,
  rel: Schema.optionalKey(Schema.String),
  describedby: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  hreflang: Schema.optionalKey(Schema.String),
  meta: Schema.optionalKey(AnyMeta)
})

export const Link = Schema.Union([Schema.String, LinkObject])

// A resource's `links` only standardises `self`.
export const ResourceLinks = Schema.Struct({
  self: Schema.optionalKey(Link)
})

// A relationship's `links` standardise `self` and `related`.
export const RelationshipLinks = Schema.Struct({
  self: Schema.optionalKey(Link),
  related: Schema.optionalKey(Link)
})

// Top-level `links` add pagination (each nullable).
export const TopLevelLinks = Schema.Struct({
  self: Schema.optionalKey(Link),
  related: Schema.optionalKey(Link),
  first: Schema.optionalKey(Schema.NullOr(Link)),
  last: Schema.optionalKey(Schema.NullOr(Link)),
  prev: Schema.optionalKey(Schema.NullOr(Link)),
  next: Schema.optionalKey(Schema.NullOr(Link))
})

// Standard members typed precisely, profile-defined members still admitted.
// `Link` is assignable to `NullOr(Link)`, so the fixed/rest constraint holds.
export const RelationshipLinksOpen = Schema.StructWithRest(RelationshipLinks, [
  Schema.Record(Schema.String, Schema.NullOr(Link))
])

// ---------------------------------------------------------------------------
// jsonapi object (closed version set)
// ---------------------------------------------------------------------------

export const JsonApiObject = Schema.Struct({
  version: Schema.optionalKey(Schema.Literals(["1.0", "1.1"])),
  ext: Schema.optionalKey(Schema.Array(Schema.String)),
  profile: Schema.optionalKey(Schema.Array(Schema.String)),
  meta: Schema.optionalKey(AnyMeta)
})

// ---------------------------------------------------------------------------
// Resource identity
// ---------------------------------------------------------------------------

// Branded id string, distinct per resource type.
export const ResourceId = <const T extends string>(type: T) =>
  Schema.String.pipe(Schema.brand(`${type}Id`))

// Resource identifier object: { type, id, meta? }. `meta` is parameterized.
export const ResourceIdentifier = <
  const T extends string,
  M extends Schema.Top = typeof AnyMeta
>(type: T, meta?: M) =>
  Schema.Struct({
    type: Schema.tag(type),
    id: ResourceId(type),
    // `as M` is the price of an optional generic with a runtime default;
    // sound in the omitted case (M defaults to typeof AnyMeta).
    meta: Schema.optionalKey((meta ?? AnyMeta) as M)
  })

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export const toOne = <const T extends string, M extends Schema.Top = typeof AnyMeta>(
  type: T,
  meta?: M
) =>
  Schema.Struct({
    data: Schema.NullOr(ResourceIdentifier(type)),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey((meta ?? AnyMeta) as M)
  })

export const toMany = <const T extends string, M extends Schema.Top = typeof AnyMeta>(
  type: T,
  meta?: M
) =>
  Schema.Struct({
    data: Schema.Array(ResourceIdentifier(type)),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey((meta ?? AnyMeta) as M)
  })

// `data` is kept required — the strongest guarantee for the common "linkage is
// always present" case. If a server may send links/meta only, wrap `data` in
// `Schema.optionalKey(...)` and, if you need the spec's "at least one of
// data/links/meta" enforced at runtime, add a `Schema.check` filter. Note a
// filter validates but does not narrow the static type.

// ---------------------------------------------------------------------------
// Resource object factory
// ---------------------------------------------------------------------------

export const JsonApiResource = <
  const Type extends string,
  Attributes extends Schema.Struct.Fields,
  Relationships extends Schema.Struct.Fields = {},
  M extends Schema.Top = typeof AnyMeta
>(
  type: Type,
  fields: {
    readonly attributes: Attributes
    readonly relationships?: Relationships
    readonly meta?: M
  }
) =>
  Schema.Struct({
    type: Schema.tag(type),
    id: ResourceId(type),
    attributes: Schema.Struct(fields.attributes),
    relationships: Schema.optionalKey(
      Schema.Struct((fields.relationships ?? {}) as Relationships)
    ),
    links: Schema.optionalKey(ResourceLinks),
    meta: Schema.optionalKey((fields.meta ?? AnyMeta) as M)
  })

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// `source` members are alternatives — model as a union, not three optional keys.
export const ErrorSource = Schema.Union([
  Schema.Struct({ pointer: Schema.String }),
  Schema.Struct({ parameter: Schema.String }),
  Schema.Struct({ header: Schema.String })
])

const errorLinks = Schema.Struct({
  about: Schema.optionalKey(Link),
  type: Schema.optionalKey(Link)
})

// Default error object: open `code`.
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

// Tightened error object: closed `code` union per endpoint. `code` stays
// optional (the spec permits omission); drop `optionalKey` to force presence.
export const JsonApiError = <const Codes extends ReadonlyArray<string>>(codes: Codes) =>
  Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    links: Schema.optionalKey(errorLinks),
    status: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.Literals(codes)),
    title: Schema.optionalKey(Schema.String),
    detail: Schema.optionalKey(Schema.String),
    source: Schema.optionalKey(ErrorSource),
    meta: Schema.optionalKey(AnyMeta)
  })

// ---------------------------------------------------------------------------
// Top-level documents (exactly one of data / errors / meta)
// ---------------------------------------------------------------------------

export const DataDocument = <
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Unknown,
  M extends Schema.Top = typeof AnyMeta
>(
  resource: R,
  included?: Included,
  meta?: M
) =>
  Schema.Struct({
    data: Schema.Union([resource, Schema.Array(resource), Schema.Null]),
    included: Schema.optionalKey(Schema.Array((included ?? Schema.Unknown) as Included)),
    links: Schema.optionalKey(TopLevelLinks),
    meta: Schema.optionalKey((meta ?? AnyMeta) as M),
    jsonapi: Schema.optionalKey(JsonApiObject)
  })

// Stricter `data: ReadonlyArray<resource>` for list endpoints.
export const CollectionDocument = <
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Unknown,
  M extends Schema.Top = typeof AnyMeta
>(
  resource: R,
  included?: Included,
  meta?: M
) =>
  Schema.Struct({
    data: Schema.Array(resource),
    included: Schema.optionalKey(Schema.Array((included ?? Schema.Unknown) as Included)),
    links: Schema.optionalKey(TopLevelLinks),
    meta: Schema.optionalKey((meta ?? AnyMeta) as M),
    jsonapi: Schema.optionalKey(JsonApiObject)
  })

export const ErrorDocument = <E extends Schema.Top = typeof ErrorObject>(error?: E) =>
  Schema.Struct({
    errors: Schema.Array((error ?? ErrorObject) as E).check(Schema.isMinLength(1)),
    links: Schema.optionalKey(TopLevelLinks),
    meta: Schema.optionalKey(AnyMeta),
    jsonapi: Schema.optionalKey(JsonApiObject)
  })

export const MetaDocument = <M extends Schema.Top = typeof AnyMeta>(meta?: M) =>
  Schema.Struct({
    meta: (meta ?? AnyMeta) as M,
    links: Schema.optionalKey(TopLevelLinks),
    jsonapi: Schema.optionalKey(JsonApiObject)
  })

export const JsonApiDocument = <
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Unknown,
  M extends Schema.Top = typeof AnyMeta,
  E extends Schema.Top = typeof ErrorObject
>(
  resource: R,
  options?: {
    readonly included?: Included
    readonly meta?: M
    readonly error?: E
  }
) =>
  Schema.Union([
    DataDocument(resource, options?.included, options?.meta),
    ErrorDocument(options?.error),
    MetaDocument(options?.meta)
  ])

// ===========================================================================
// Worked example
// ===========================================================================

export const Person = JsonApiResource("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString
  }
})

export const Comment = JsonApiResource("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: { author: toOne("people") }
})

export const Article = JsonApiResource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    subtitle: Schema.optionalKey(Schema.String),
    // Wire form is an ISO-8601 string (JSON has no native date); the schema
    // decodes to a `Date` instance.
    createdAt: Schema.DateFromString
  },
  relationships: {
    author: toOne("people"),
    comments: toMany("comments")
  }
})

// Create payload: { data: { type, attributes, relationships? } } — no id.
export const ArticleCreate = Schema.Struct({
  data: Article.mapFields(Struct.omit(["id"]))
})

// Typed collection meta, passed where the shape is known.
export const PageMeta = Schema.Struct({
  total: Schema.Int,
  pageSize: Schema.Int
})

export type Article = typeof Article.Type
export type ArticleEncoded = typeof Article.Encoded

// Fetch response: discriminated `included`, typed pagination meta.
export const ArticleDocument = DataDocument(
  Article,
  Schema.Union([Person, Comment]),
  PageMeta
)

// Full document union (data | errors | meta) with a closed error-code set.
export const ArticleApiDocument = JsonApiDocument(Article, {
  included: Schema.Union([Person, Comment]),
  meta: PageMeta,
  error: JsonApiError(["title_taken", "forbidden", "not_found"])
})

// ---------------------------------------------------------------------------
// Decode / construct
// ---------------------------------------------------------------------------

// `onExcessProperty: "error"` rejects members not declared by the schema.
export const decodeArticleDocument = (input: unknown) =>
  Schema.decodeUnknownExit(ArticleDocument)(input, { onExcessProperty: "error" })

export const draftArticle = Article.make({
  id: ResourceId("articles").make("1"),
  attributes: { title: "Hello", body: "World", createdAt: new Date() },
  relationships: {
    author: { data: { type: "people", id: ResourceId("people").make("9") } },
    comments: { data: [{ type: "comments", id: ResourceId("comments").make("5") }] }
  }
})
