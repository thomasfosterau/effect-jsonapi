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
import { JsonPointer, Option, Schema } from "effect";

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
export const AnyMeta = Schema.Record(Schema.String, Schema.Unknown);

/**
 * The decoded type of an {@link AnyMeta} free-form metadata object.
 *
 * @since 0.18.0
 * @category models
 */
export type AnyMeta = typeof AnyMeta.Type;

// ---------------------------------------------------------------------------
// Links (JSON:API 1.1 link object + per-context member sets)
// ---------------------------------------------------------------------------

/**
 * A URI-reference, decoded to a richer type where possible.
 *
 * JSON:API links are URI-*references*: they may be absolute (`https://…`) or
 * relative (`/articles/1`). The WHATWG `URL` type can only represent an
 * absolute URL, so this codec decodes an *absolute* reference to a real `URL`
 * and leaves a *relative* reference as a `string` — its decoded type is
 * `URL | string`. Both encode back to the original string, so the wire format
 * is unchanged and relative links keep working.
 *
 * Use this anywhere the spec calls for a URI: link targets, `describedby`, and
 * the `jsonapi` object's `ext` / `profile` members.
 *
 * @since 0.6.0
 * @category schemas
 */
export const Url = Schema.Union([Schema.URLFromString, Schema.String]);

/**
 * The decoded type of a {@link Url}: an absolute `URL`, or a relative URI-reference `string`.
 *
 * @since 0.18.0
 * @category models
 */
export type Url = typeof Url.Type;

/**
 * A link object, per https://jsonapi.org/format/1.1/#document-links
 *
 * @since 0.1.0
 * @category schemas
 */
export const LinkObject = Schema.Struct({
  href: Url,
  rel: Schema.optionalKey(Schema.String),
  describedby: Schema.optionalKey(Url),
  title: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  hreflang: Schema.optionalKey(Schema.String),
  meta: Schema.optionalKey(AnyMeta),
});

/**
 * The decoded type of a {@link LinkObject}.
 *
 * @since 0.18.0
 * @category models
 */
export type LinkObject = typeof LinkObject.Type;

/**
 * A link: either a {@link Url} (an absolute `URL` or a relative URI-reference
 * string) or a {@link LinkObject}.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Link = Schema.Union([Url, LinkObject]);

/**
 * The decoded type of a {@link Link}.
 *
 * @since 0.15.0
 * @category models
 */
export type Link = typeof Link.Type;

/**
 * Extracts the wire string from a {@link Link}: a `string` passes through, a
 * `URL` becomes its `.href`, and a {@link LinkObject} recurses on its own
 * `href` member. Also accepts `undefined` so it composes directly with an
 * optional link (`resource.links?.self`) without a separate guard.
 *
 * The decoded type of any link is `string | URL | LinkObject` — every
 * resource derived from `Resource.make` inherits it — so code that only wants
 * the URI a link points at otherwise has to re-derive this narrowing itself.
 * `href` is that narrowing, done once.
 *
 * @example
 * ```ts
 * import { Document } from "@thomasfosterau/effect-jsonapi"
 *
 * Document.href("/articles/1") // "/articles/1"
 * Document.href(new URL("https://example.com/articles/1")) // "https://example.com/articles/1"
 * Document.href({ href: "https://example.com/articles/1" }) // "https://example.com/articles/1"
 * Document.href(undefined) // undefined
 * ```
 *
 * @since 0.15.0
 * @category accessors
 */
export function href(link: Link): string;
export function href(link: Link | undefined): string | undefined;
export function href(link: Link | undefined): string | undefined {
  if (link === undefined) return undefined;
  if (typeof link === "string") return link;
  if (link instanceof URL) return link.href;
  return href(link.href);
}

/**
 * A resource object's `links`: the spec standardises `self`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ResourceLinks = Schema.Struct({
  self: Schema.optionalKey(Link),
});

/**
 * The decoded type of a resource object's {@link ResourceLinks}.
 *
 * @since 0.18.0
 * @category models
 */
export type ResourceLinks = typeof ResourceLinks.Type;

/**
 * A relationship object's `links`: the spec standardises `self` and `related`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const RelationshipLinks = Schema.Struct({
  self: Schema.optionalKey(Link),
  related: Schema.optionalKey(Link),
});

/**
 * The decoded type of a relationship object's {@link RelationshipLinks}.
 *
 * @since 0.18.0
 * @category models
 */
export type RelationshipLinks = typeof RelationshipLinks.Type;

/**
 * {@link RelationshipLinks} that also admits profile-defined members.
 *
 * @since 0.1.0
 * @category schemas
 */
export const RelationshipLinksOpen = Schema.StructWithRest(RelationshipLinks, [
  Schema.Record(Schema.String, Schema.NullOr(Link)),
]);

/**
 * The decoded type of {@link RelationshipLinksOpen}: relationship links plus profile-defined members.
 *
 * @since 0.18.0
 * @category models
 */
export type RelationshipLinksOpen = typeof RelationshipLinksOpen.Type;

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
  related: Link,
});

/**
 * The decoded type of a paginated relationship's {@link PaginatedRelationshipLinks}.
 *
 * @since 0.18.0
 * @category models
 */
export type PaginatedRelationshipLinks = typeof PaginatedRelationshipLinks.Type;

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
  next: Schema.optionalKey(Schema.NullOr(Link)),
});

/**
 * The decoded type of a document's {@link TopLevelLinks}.
 *
 * @since 0.18.0
 * @category models
 */
export type TopLevelLinks = typeof TopLevelLinks.Type;

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
  ext: Schema.optionalKey(Schema.Array(Url)),
  profile: Schema.optionalKey(Schema.Array(Url)),
  meta: Schema.optionalKey(AnyMeta),
});

/**
 * The decoded type of the top-level {@link JsonApiObject}.
 *
 * @since 0.18.0
 * @category models
 */
export type JsonApiObject = typeof JsonApiObject.Type;

/**
 * A ready-made `jsonapi` member value advertising JSON:API v1.1.
 *
 * @since 0.1.0
 * @category constants
 */
export const v1_1: typeof JsonApiObject.Type = { version: "1.1" };

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
  Schema.Struct({ header: Schema.String }),
]);

/**
 * The decoded type of an error's {@link ErrorSource}.
 *
 * @since 0.18.0
 * @category models
 */
export type ErrorSource = typeof ErrorSource.Type;

const memberPointer =
  (kind: "attributes" | "relationships") =>
  (name: string, options?: { readonly index?: number }): string =>
    options?.index !== undefined
      ? `/data/${options.index}/${kind}/${JsonPointer.escapeToken(name)}`
      : `/data/${kind}/${JsonPointer.escapeToken(name)}`;

/**
 * JSON Pointer (RFC 6901) constructors for the `source.pointer` a JSON:API
 * error carries — build one here rather than string-concatenating
 * `/data/attributes/<name>` at each call site declaring an `ApiError` (see
 * its `source` option).
 *
 * `attribute` / `relationship` point at a resource's own member;
 * `{ index }` gives the equivalent pointer inside a collection payload's
 * `data` array. `escape` is `effect`'s own {@link JsonPointer.escapeToken} —
 * the constructors already apply it to `name` — reach for it only when a
 * pointer segment is built by hand.
 *
 * @example
 * ```ts
 * import { Document } from "@thomasfosterau/effect-jsonapi"
 *
 * Document.pointer.attribute("title")
 * Document.pointer.relationship("author")
 * Document.pointer.attribute("title", { index: 2 })
 * Document.pointer.escape("a/b")
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const pointer = {
  /**
   * A JSON Pointer to a resource's attribute member:
   * `/data/attributes/<name>`, or `/data/<index>/attributes/<name>` inside a
   * collection payload's `data` array.
   *
   * @example
   * ```ts
   * import { Document } from "@thomasfosterau/effect-jsonapi"
   *
   * Document.pointer.attribute("title") // "/data/attributes/title"
   * Document.pointer.attribute("title", { index: 2 }) // "/data/2/attributes/title"
   * ```
   *
   * @since 0.15.0
   * @category constructors
   */
  attribute: memberPointer("attributes"),
  /**
   * A JSON Pointer to a resource's relationship member:
   * `/data/relationships/<name>`, or `/data/<index>/relationships/<name>`
   * inside a collection payload's `data` array.
   *
   * @example
   * ```ts
   * import { Document } from "@thomasfosterau/effect-jsonapi"
   *
   * Document.pointer.relationship("author") // "/data/relationships/author"
   * Document.pointer.relationship("author", { index: 2 }) // "/data/2/relationships/author"
   * ```
   *
   * @since 0.15.0
   * @category constructors
   */
  relationship: memberPointer("relationships"),
  /**
   * RFC 6901-escapes one JSON Pointer segment: `~` → `~0`, `/` → `~1`. A thin
   * re-export of `effect`'s own {@link JsonPointer.escapeToken}. The
   * {@link pointer.attribute} / {@link pointer.relationship} constructors
   * already apply this to `name` — reach for it directly only when building
   * a pointer segment that isn't a plain member name.
   *
   * @example
   * ```ts
   * import { Document } from "@thomasfosterau/effect-jsonapi"
   *
   * Document.pointer.escape("a/b") // "a~1b"
   * Document.pointer.escape("a~b") // "a~0b"
   * ```
   *
   * @since 0.15.0
   * @category constructors
   */
  escape: JsonPointer.escapeToken,
} as const;

/**
 * The member a JSON Pointer built by {@link pointer} — or parsed by
 * {@link parsePointer} — names: a resource's attribute or relationship,
 * optionally scoped to a collection payload's `data` array element (`index`).
 *
 * @since 0.15.0
 * @category models
 */
export interface PointerMember {
  readonly _tag: "attribute" | "relationship";
  readonly name: string;
  readonly index?: number;
}

/**
 * Parses a JSON Pointer back into the resource member it names — the inverse
 * of {@link pointer}, with RFC 6901 unescaping (`effect`'s own
 * {@link JsonPointer.unescapeToken}) applied to the member name.
 *
 * Returns `None` for anything that isn't an attribute or relationship
 * pointer under `/data` (or `/data/<index>`) — including a pointer whose
 * final segment is empty (`/data/attributes/`), which real servers emit and
 * which a hand-rolled parser has to special-case.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 * import { Document } from "@thomasfosterau/effect-jsonapi"
 *
 * Document.parsePointer("/data/attributes/title")
 * // → Option.some({ _tag: "attribute", name: "title" })
 *
 * Document.parsePointer("/data/2/relationships/author")
 * // → Option.some({ _tag: "relationship", name: "author", index: 2 })
 *
 * Document.parsePointer("/data/id") // → Option.none() — not a member pointer
 * Document.parsePointer("/data/attributes/") // → Option.none() — empty name
 *
 * console.log(Option.isSome(Document.parsePointer("/data/attributes/title")))
 * ```
 *
 * @since 0.15.0
 * @category utils
 */
export const parsePointer = (value: string): Option.Option<PointerMember> => {
  if (!value.startsWith("/")) return Option.none();
  const segments = value.split("/").slice(1).map(JsonPointer.unescapeToken);
  if (segments[0] !== "data") return Option.none();
  let rest = segments.slice(1);
  let index: number | undefined;
  if (rest.length === 3 && /^\d+$/.test(rest[0]!)) {
    index = Number(rest[0]);
    rest = rest.slice(1);
  }
  if (rest.length !== 2) return Option.none();
  const [kind, name] = rest as [string, string];
  if (name === "") return Option.none();
  if (kind === "attributes")
    return Option.some(
      index === undefined ? { _tag: "attribute", name } : { _tag: "attribute", name, index },
    );
  if (kind === "relationships") {
    return Option.some(
      index === undefined ? { _tag: "relationship", name } : { _tag: "relationship", name, index },
    );
  }
  return Option.none();
};

const errorLinks = Schema.Struct({
  about: Schema.optionalKey(Link),
  type: Schema.optionalKey(Link),
});

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
  meta: Schema.optionalKey(AnyMeta),
});

/**
 * The decoded type of a JSON:API {@link ErrorObject}.
 *
 * @since 0.18.0
 * @category models
 */
export type ErrorObject = typeof ErrorObject.Type;

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
    code: Schema.optionalKey(Schema.Literals(codes)),
  });

// ---------------------------------------------------------------------------
// Top-level documents (exactly one of data / errors / meta)
// ---------------------------------------------------------------------------

// The top-level members every data and linkage document carries beside
// `data` and `included`: `links`, `meta` (at the caller's schema, `AnyMeta`
// by default) and `jsonapi`.
const topLevelMembers = <M extends Schema.Top>(meta: M | undefined) => ({
  links: Schema.optionalKey(TopLevelLinks),
  // SAFETY: `M` defaults to `typeof AnyMeta`, the schema used when none is passed.
  meta: Schema.optionalKey((meta ?? AnyMeta) as M),
  jsonapi: Schema.optionalKey(JsonApiObject),
});

// The `included` member of a data document: an optional array of `Included`,
// `Schema.Never` (no member admitted) by default.
const includedMember = <Included extends Schema.Top>(included: Included | undefined) => ({
  // SAFETY: `Included` defaults to `typeof Schema.Never`, the schema used when none is passed.
  included: Schema.optionalKey(Schema.Array((included ?? Schema.Never) as Included)),
});

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
  M extends Schema.Top = typeof AnyMeta,
> extends Schema.Struct<{
  readonly data: R;
  readonly included: Schema.optionalKey<Schema.$Array<Included>>;
  readonly links: Schema.optionalKey<typeof TopLevelLinks>;
  readonly meta: Schema.optionalKey<M>;
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>;
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
 *   - `DataDocument(Article.nullable())` → `data: Option<Article>`, decoding and
 *     encoding `None ⇆ null` on the wire (`Article.nullable()` is
 *     `Schema.OptionFromNullOr(Article)`).
 *
 * It generalises to linkage with no special case, e.g.
 * `DataDocument(Schema.NullOr(Comment.identifier))`.
 *
 * **Nullable data:** use `Schema.NullOr(R)` for `R | null`, or the spec-clean
 * `R.nullable()` / `Schema.OptionFromNullOr(R)` for `Option<R>`. Do *not* reach
 * for effect's *structural* `Schema.Option` (`{ _tag, value }`): it serialises a
 * non-conformant body, and `DataDocument` cannot tell the two codecs apart.
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
  M extends Schema.Top = typeof AnyMeta,
>(
  data: R,
  options?: {
    readonly included?: Included | undefined;
    readonly meta?: M | undefined;
  },
): DataDocument<R, Included, M> =>
  Schema.Struct({
    data,
    ...includedMember(options?.included),
    ...topLevelMembers(options?.meta),
  });

/**
 * The decoded *value* type of a single-resource data document for `R` — the
 * value side of {@link DataDocument}, including the optional top-level
 * `jsonapi` member.
 *
 * Lets consumers name a document-assembling function's return type
 * (`assemble(...): Document.Value<typeof Article>`) instead of hand-rolling the
 * `{ data, included?, links?, meta?, jsonapi? }` envelope. The runtime
 * counterpart `Handlers.DocumentValue` describes the looser shape the
 * `Handlers.data` / `Handlers.collection` builders return.
 *
 * @since 0.3.0
 * @category models
 */
export type Value<
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
  M extends Schema.Top = typeof AnyMeta,
> = DataDocument<R, Included, M>["Type"];

/**
 * A collection document: `data` is an array of resources (possibly empty).
 *
 * @since 0.1.0
 * @category models
 */
export interface CollectionDocument<
  R extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
  M extends Schema.Top = typeof AnyMeta,
> extends Schema.Struct<{
  readonly data: Schema.$Array<R>;
  readonly included: Schema.optionalKey<Schema.$Array<Included>>;
  readonly links: Schema.optionalKey<typeof TopLevelLinks>;
  readonly meta: Schema.optionalKey<M>;
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>;
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
  M extends Schema.Top = typeof AnyMeta,
>(
  resource: R,
  options?: {
    readonly included?: Included | undefined;
    readonly meta?: M | undefined;
  },
): CollectionDocument<R, Included, M> =>
  Schema.Struct({
    data: Schema.Array(resource),
    ...includedMember(options?.included),
    ...topLevelMembers(options?.meta),
  });

/**
 * A relationship-linkage document: the top-level document served by
 * relationship endpoints (`GET /articles/1/relationships/comments`).
 *
 * `data` is resource linkage — one identifier, `identifier | null`, or an
 * identifier array, depending on the relationship kind — never full resource
 * objects.
 *
 * A relationship document may also be a compound document (JSON:API 1.1
 * §Inclusion of Related Resources: `GET /articles/1/relationships/comments?include=comments.author`):
 * pass an `Included` union and the document gains an optional `included`
 * member carrying the resources its identifiers name, and the resources
 * reached from those. Left at its default (`Schema.Never`), the document has
 * no `included` member at all, as before.
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-relationships}
 *
 * @since 0.1.0 (`Included` since 0.18.0)
 * @category models
 */
export interface LinkageDocument<
  D extends Schema.Top,
  M extends Schema.Top = typeof AnyMeta,
  Included extends Schema.Top = typeof Schema.Never,
> extends Schema.Struct<LinkageDocumentFields<D, M, Included>> {}

/**
 * The struct fields of a {@link LinkageDocument}: `data`, `links`, `meta` and
 * `jsonapi`, plus an optional `included` member unless `Included` is
 * `Schema.Never`.
 *
 * @since 0.18.0
 * @category type-level
 */
export type LinkageDocumentFields<
  D extends Schema.Top,
  M extends Schema.Top,
  Included extends Schema.Top,
> = {
  readonly data: D;
  readonly links: Schema.optionalKey<typeof TopLevelLinks>;
  readonly meta: Schema.optionalKey<M>;
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>;
} & ([Included] extends [typeof Schema.Never]
  ? unknown
  : { readonly included: Schema.optionalKey<Schema.$Array<Included>> });

/**
 * Creates a relationship-linkage document schema. Pass the linkage shape as
 * `data`: an identifier schema, `Schema.NullOr(identifier)` or
 * `Schema.Array(identifier)`.
 *
 * Pass `included` — the union of the resources the document may carry — to
 * make it a compound relationship document, with an optional `included`
 * member. Without it the document has no `included` member.
 *
 * @example
 * ```ts
 * import { Document, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Person = Resource.make("people", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * // Linkage document for a to-one relationship endpoint.
 * const AuthorLinkage = Document.LinkageDocument(Schema.NullOr(Person.identifier))
 *
 * // A compound one: `GET /articles/1/relationships/comments?include=comments.author`
 * const CommentsLinkage = Document.LinkageDocument(Schema.Array(Comment.identifier), {
 *   included: Schema.Union([Comment, Person])
 * })
 * Schema.decodeUnknownSync(CommentsLinkage)({
 *   data: [{ type: "comments", id: "5" }],
 *   included: [
 *     {
 *       type: "comments",
 *       id: "5",
 *       attributes: { body: "First!" },
 *       relationships: { author: { data: { type: "people", id: "9" } } }
 *     },
 *     { type: "people", id: "9", attributes: { name: "Dan" } }
 *   ]
 * })
 * ```
 *
 * @since 0.1.0 (`included` since 0.18.0)
 * @category constructors
 */
export const LinkageDocument = <
  D extends Schema.Top,
  M extends Schema.Top = typeof AnyMeta,
  Included extends Schema.Top = typeof Schema.Never,
>(
  data: D,
  options?: {
    readonly meta?: M | undefined;
    readonly included?: Included | undefined;
  },
): LinkageDocument<D, M, Included> =>
  // SAFETY: the struct's fields are `LinkageDocumentFields<D, M, Included>`:
  // `included` only when an `Included` union was passed.
  Schema.Struct(
    options?.included === undefined
      ? { data, ...topLevelMembers(options?.meta) }
      : { data, ...includedMember(options.included), ...topLevelMembers(options.meta) },
  ) as unknown as LinkageDocument<D, M, Included>;

/**
 * An error document: a non-empty `errors` array, never `data`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ErrorDocument<E extends Schema.Top = typeof ErrorObject> extends Schema.Struct<{
  readonly errors: Schema.$Array<E>;
  readonly links: Schema.optionalKey<typeof TopLevelLinks>;
  readonly meta: Schema.optionalKey<typeof AnyMeta>;
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>;
}> {}

/**
 * Creates an error document schema: a non-empty `errors` array, never `data`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const ErrorDocument = <E extends Schema.Top = typeof ErrorObject>(
  error?: E,
): ErrorDocument<E> =>
  Schema.Struct({
    errors: Schema.Array((error ?? ErrorObject) as E).check(Schema.isMinLength(1)),
    links: Schema.optionalKey(TopLevelLinks),
    meta: Schema.optionalKey(AnyMeta),
    jsonapi: Schema.optionalKey(JsonApiObject),
  });

/**
 * A meta-only document.
 *
 * @since 0.1.0
 * @category models
 */
export interface MetaDocument<M extends Schema.Top = typeof AnyMeta> extends Schema.Struct<{
  readonly meta: M;
  readonly links: Schema.optionalKey<typeof TopLevelLinks>;
  readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>;
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
    jsonapi: Schema.optionalKey(JsonApiObject),
  });

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
  E extends Schema.Top = typeof ErrorObject,
> extends Schema.Union<
  readonly [DataDocument<R, Included, M>, ErrorDocument<E>, MetaDocument<M>]
> {}

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
  E extends Schema.Top = typeof ErrorObject,
>(
  resource: R,
  options?: {
    readonly included?: Included | undefined;
    readonly meta?: M | undefined;
    readonly error?: E | undefined;
  },
): Document<R, Included, M, E> =>
  Schema.Union([
    DataDocument(resource, { included: options?.included, meta: options?.meta }),
    ErrorDocument(options?.error),
    MetaDocument(options?.meta),
  ]);

// ---------------------------------------------------------------------------
// Wire form — string links
// ---------------------------------------------------------------------------

/**
 * `T` with every `URL`-typed link value replaced by a plain `string`,
 * recursively — the *wire* form of a resource whose links a server builds as
 * `URL`s internally ("URL internal, string on the wire").
 *
 * `Date` values, branded ids (`string & Brand<…>` — an object-flavoured
 * intersection that must not fall into the mapped-object branch) and
 * array / object mutability and optionality are all preserved, so wire types
 * stay assignable wherever the model types were.
 *
 * @since 0.16.0
 * @category type-level
 */
export type Wire<T> = T extends URL
  ? string
  : T extends Date
    ? T
    : T extends string
      ? T
      : T extends Array<infer E>
        ? Array<Wire<E>>
        : T extends ReadonlyArray<infer E>
          ? ReadonlyArray<Wire<E>>
          : T extends object
            ? { [K in keyof T]: Wire<T[K]> }
            : T;

/**
 * The schema {@link wire} returns: `S` with its links as strings, on both
 * sides — a plain codec whose `Type` is `Wire<S["Type"]>`.
 *
 * @since 0.16.0
 * @category models
 */
export interface WireSchema<S extends Schema.Top> extends Schema.Codec<
  Wire<S["Type"]>,
  Wire<S["Encoded"]>,
  S["DecodingServices"],
  S["EncodingServices"]
> {}

const isStructLike = (
  schema: unknown,
): schema is Schema.Top & { readonly fields: { readonly [key: string]: Schema.Top } } =>
  Schema.isSchema(schema) &&
  typeof (schema as { readonly fields?: unknown }).fields === "object" &&
  (schema as { readonly fields?: unknown }).fields !== null;

const isUnionLike = (
  schema: unknown,
): schema is Schema.Top & { readonly members: ReadonlyArray<Schema.Top> } =>
  Schema.isSchema(schema) && Array.isArray((schema as { readonly members?: unknown }).members);

/** The `_tag` of a schema's AST node, when it exposes one. */
const astTag = (schema: Schema.Top): string | undefined =>
  (schema as { readonly ast?: { readonly _tag?: string } }).ast?._tag;

/**
 * Whether a struct field is declared optional — `Schema.optionalKey(S)` or
 * `Schema.optional(S)`; both stamp `isOptional` on the field's AST context,
 * the only marker that distinguishes `optionalKey(Link)` from the `Link`
 * union it wraps (both report `_tag: "Union"`).
 */
const isOptionalField = (schema: Schema.Top): boolean =>
  (schema as { readonly ast?: { readonly context?: { readonly isOptional?: boolean } } }).ast
    ?.context?.isOptional === true;

/**
 * Splits a struct field into its inner schema and the re-wrapper that
 * restores its optionality. `Schema.optionalKey(S)` exposes `S` as
 * `.schema`; `Schema.optional(S)` is `optionalKey(UndefinedOr(S))` and
 * exposes the union — hence the explicit `Undefined`-member check rather
 * than blindly taking `members[0]`, which would mistake a genuine union (the
 * package's `Link`) for that wrapper.
 */
const splitOptionality = (
  schema: Schema.Top,
): readonly [Schema.Top, (rebuilt: Schema.Top) => Schema.Top] => {
  const identity = (rebuilt: Schema.Top): Schema.Top => rebuilt;
  if (!isOptionalField(schema)) return [schema, identity];
  const inner = (schema as { readonly schema?: unknown }).schema;
  if (!Schema.isSchema(inner)) return [schema, identity];
  if (isUnionLike(inner) && inner.members.some((m) => astTag(m) === "Undefined")) {
    const concrete = inner.members.find((m) => astTag(m) !== "Undefined");
    if (concrete !== undefined) return [concrete, (rebuilt) => Schema.optional(rebuilt)];
  }
  return [inner, (rebuilt) => Schema.optionalKey(rebuilt)];
};

/** One link member forced to a wire string, preserving its optionality. */
const wireLinkField = (field: Schema.Top): Schema.Top => {
  const [inner, rewrap] = splitOptionality(field);
  return astTag(inner) === "String" ? field : rewrap(Schema.String);
};

/**
 * A `links` block rebuilt member by member (so `self` *and* `related` both
 * survive, each keeping its own optionality) with every member a wire string.
 */
const wireLinkBlock = (links: Schema.Top): Schema.Top => {
  const [inner, rewrap] = splitOptionality(links);
  if (!isStructLike(inner)) return links;
  return rewrap(
    Schema.Struct(
      Object.fromEntries(
        Object.entries(inner.fields).map(([key, field]) => [key, wireLinkField(field)]),
      ),
    ),
  );
};

/** A relationship object (`{ data, links, meta }`) with its `links` block wired. */
const wireRelationship = (relationship: Schema.Top): Schema.Top => {
  const [inner, rewrap] = splitOptionality(relationship);
  const links = isStructLike(inner) ? inner.fields["links"] : undefined;
  if (links === undefined || !isStructLike(inner)) return relationship;
  return rewrap(Schema.Struct({ ...inner.fields, links: wireLinkBlock(links) }));
};

/**
 * The wire variant of a resource schema: `links.self` and every
 * relationship's `links.related` (and `self`) become plain strings — the
 * shape a server emits once it has stringified the `URL`s it built
 * internally, and therefore the shape its endpoints' `success:` documents
 * must declare, or the response encoder rejects every document carrying a
 * link.
 *
 * Only the link fields change: attributes, ids, `Date` codecs and the
 * optionality of every member are untouched, and a union (a polymorphic
 * `included` whitelist) wires each member. A schema that is not a struct
 * passes through unchanged.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Document, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 *
 * // `Resource.make` declares `links.self` as `URL | string`; on the wire it is a string
 * const Wire = Document.wire(Article)
 * const decoded = Schema.decodeUnknownSync(Wire)({
 *   type: "articles",
 *   id: "1",
 *   attributes: { title: "Hi" },
 *   links: { self: "https://example.test/articles/1" }
 * })
 * console.log(typeof decoded.links?.self)
 * // → string
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const wire = <S extends Schema.Top>(schema: S): WireSchema<S> => {
  // The casts are the honest assertion this function makes: the rebuilt
  // schema differs from `S` only in its link fields, which `Wire` mirrors at
  // the type level.
  if (isUnionLike(schema)) {
    return Schema.Union(schema.members.map(wire)) as unknown as WireSchema<S>;
  }
  if (!isStructLike(schema)) return schema as unknown as WireSchema<S>;
  const fields: { [key: string]: Schema.Top } = { ...schema.fields };
  // `Resource.make` declares both blocks with `Schema.optionalKey`, so each is
  // unwrapped before its members are reachable and re-wrapped after.
  const links = fields["links"];
  if (links !== undefined) fields["links"] = wireLinkBlock(links);
  const relationships = fields["relationships"];
  if (relationships !== undefined) {
    const [inner, rewrap] = splitOptionality(relationships);
    if (isStructLike(inner)) {
      fields["relationships"] = rewrap(
        Schema.Struct(
          Object.fromEntries(
            Object.entries(inner.fields).map(([key, field]) => [key, wireRelationship(field)]),
          ),
        ),
      );
    }
  }
  return Schema.Struct(fields) as unknown as WireSchema<S>;
};
