/**
 * Typed JSON:API query parameters.
 *
 * Models the spec's query parameter families as typed schemas derived from a
 * resource definition:
 *
 *   - `include`   — compound document inclusion paths (`?include=author,comments.author`)
 *   - `fields`    — sparse fieldsets (`?fields[articles]=title,body`)
 *   - `sort`      — sort fields (`?sort=-createdAt,title`)
 *   - `page`      — pagination (`?page[offset]=0&page[limit]=10`)
 *   - `filter`    — filtering (`?filter[status]=open&filter[age][gt]=18`, the
 *                   filter grammar over the resource's declaration, or a
 *                   user-defined per-key map)
 *
 * On the wire these are flat, bracket-keyed string parameters; handlers see an
 * ergonomic nested, fully-decoded shape:
 *
 * ```ts
 * {
 *   include?: ReadonlyArray<"author" | "comments" | "comments.author">   // from the relationship graph
 *   fields?:  { articles?: ReadonlyArray<"title" | "body">, ... }
 *   sort?:    ReadonlyArray<{ field: "title" | ..., direction: "asc" | "desc" }>
 *   page?:    { offset?: number, limit?: number }
 *   filter?:  Filter.Ast<{ status: string, age: number }>                 // `filter: true`
 * }
 * ```
 *
 * Illegal values (unknown include paths, unknown sparse-fieldset names,
 * unknown sort fields, unknown filter fields or operators, bad filter
 * literals) fail decoding, which HttpApi surfaces as a 400 — the
 * spec-compliant response.
 *
 * `?include=` accepts both spellings of the same set: the spec's comma grammar
 * (`?include=a,b`) and the repeated key (`?include=a&include=b`) that
 * `UrlParams.toRecord` decodes to an array. Both decode identically; encoding
 * always emits the comma form.
 *
 * A decoded query has exactly one wire spelling, the **canonical query
 * string** ({@link canonical}): the families in a fixed order, each key
 * sorted or in its codec's canonical order, RFC 3986 percent-encoded. It is
 * what a collection document's `self` link carries and what a consumer can
 * use as the identity of a query.
 *
 * @since 0.1.0
 */
import type { SchemaAST, Types } from "effect"
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"
import type { Ast, Node } from "./Filter.js"
import { Ast as AstSchema, PROFILE_URI } from "./Filter.js"
import type { Pair as CanonicalPair } from "./internal/canonical.js"
import { declaredKeys, orderPairs, serialise as serialisePairs } from "./internal/canonical.js"
import { CommaSeparated, flatten, nest, Repeatable, Sort as SortCodec } from "./internal/codecs.js"
import type { FieldCodecs } from "./internal/filter.js"
import { decodeFilter, encodeFilter, isFilterKey, literalEncoder, operatorCheck, prepare } from "./internal/filter.js"
import type {
  Any,
  AttributeKeys,
  Filterable,
  FilterableKeys,
  IncludeDepth,
  IncludePath,
  IncludePathsTo,
  RelationshipTargets
} from "./Resource.js"
import { allTargets, attributeKeys, filterable, includePaths } from "./Resource.js"

// ---------------------------------------------------------------------------
// Pagination strategies
// ---------------------------------------------------------------------------

/**
 * Common pagination strategies, ready to pass as the `page` query option.
 * Each key becomes a `page[<key>]` query parameter.
 *
 * Custom strategies are plain `Schema.Struct.Fields` whose values decode from
 * strings.
 */
const PageInt = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

/**
 * Options for the {@link Page.offset} pagination factory.
 *
 * Unlike the constant {@link Page.Offset}, the factory is bounded (a `maxLimit`
 * DoS guard), can fill in decode defaults, and can decode from plain numbers
 * (`fromString: false`) for hosts that coerce query strings at the transport
 * layer and reuse the schema as a numeric call-site input.
 *
 * @since 0.3.0
 * @category models
 */
export interface OffsetPageOptions {
  /** Upper bound on `limit` (inclusive) — a DoS guard. Omit for no cap. */
  readonly maxLimit?: number
  /** Lower bound on `limit` (inclusive). Defaults to 1. */
  readonly minLimit?: number
  /** Decode default for `limit` when the wire key is absent. Omit → field stays `optionalKey`. */
  readonly defaultLimit?: number
  /** Decode default for `offset`. Omit → field stays `optionalKey`. */
  readonly defaultOffset?: number
  /**
   * `true` (default): fields decode from query strings (`FiniteFromString`, as `Page.Offset`).
   * `false`: plain numbers (`Schema.Number`) — for hosts that coerce strings at the transport layer
   * and reuse the schema as a numeric input.
   */
  readonly fromString?: boolean
}

/**
 * Options for the {@link Page.number} pagination factory — the page-number twin
 * of {@link OffsetPageOptions}, with bounds and defaults applied to the `size`
 * field and a decode default for the `number` field.
 *
 * @since 0.3.0
 * @category models
 */
export interface NumberPageOptions {
  /** Upper bound on `size` (inclusive) — a DoS guard. Omit for no cap. */
  readonly maxSize?: number
  /** Lower bound on `size` (inclusive). Defaults to 1. */
  readonly minSize?: number
  /** Decode default for `size` when the wire key is absent. Omit → field stays `optionalKey`. */
  readonly defaultSize?: number
  /** Decode default for `number`. Omit → field stays `optionalKey`. */
  readonly defaultNumber?: number
  /**
   * `true` (default): fields decode from query strings (`FiniteFromString`, as `Page.Number`).
   * `false`: plain numbers (`Schema.Number`) — for hosts that coerce strings at the transport layer.
   */
  readonly fromString?: boolean
}

// The leaf schema a factory field is built from: a plain number when the caller
// opts out of string decoding, otherwise the wire-string `FiniteFromString`.
type PageLeaf<O extends { readonly fromString?: boolean }> = O extends { readonly fromString: false }
  ? typeof Schema.Number
  : typeof Schema.FiniteFromString

// `true` when `O` carries a concrete (non-`undefined`) value for key `K`.
type HasDefaultKey<O, K extends PropertyKey> = K extends keyof O ? ([O[K]] extends [undefined] ? false : true) : false

// A defaulted key decodes to a required value (`withDecodingDefaultKey`); an
// un-defaulted key stays optional (`optionalKey`).
type PageField<L extends Schema.Top, HasDefault extends boolean> = HasDefault extends true
  ? Schema.withDecodingDefaultKey<L>
  : Schema.optionalKey<L>

/**
 * The `{ offset, limit }` field-map produced by {@link Page.offset} for a given
 * options object.
 *
 * @since 0.3.0
 * @category models
 */
export type OffsetPageFields<O extends OffsetPageOptions> = {
  readonly offset: PageField<PageLeaf<O>, HasDefaultKey<O, "defaultOffset">>
  readonly limit: PageField<PageLeaf<O>, HasDefaultKey<O, "defaultLimit">>
}

/**
 * The `{ number, size }` field-map produced by {@link Page.number} for a given
 * options object.
 *
 * @since 0.3.0
 * @category models
 */
export type NumberPageFields<O extends NumberPageOptions> = {
  readonly number: PageField<PageLeaf<O>, HasDefaultKey<O, "defaultNumber">>
  readonly size: PageField<PageLeaf<O>, HasDefaultKey<O, "defaultSize">>
}

// Wraps a leaf in `optionalKey`, or — when a default is supplied — in
// `withDecodingDefaultKey`. `withDecodingDefaultKey` takes the *encoded*
// default, so a string-coercing field needs a STRING default and a plain-number
// field a number default.
const withPageDefault = (leaf: Schema.Top, value: number | undefined, fromString: boolean): Schema.Top =>
  value === undefined
    ? Schema.optionalKey(leaf)
    : leaf.pipe(Schema.withDecodingDefaultKey(Effect.succeed(fromString ? String(value) : value)))

const offsetPage = <const O extends OffsetPageOptions = {}>(options?: O): OffsetPageFields<O> => {
  const { maxLimit, minLimit = 1, defaultLimit, defaultOffset, fromString = true } = options ?? {}
  const base = fromString ? Schema.FiniteFromString : Schema.Number
  const offsetLeaf = base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  const limitLeaf =
    maxLimit === undefined
      ? base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(minLimit))
      : base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(minLimit), Schema.isLessThanOrEqualTo(maxLimit))
  return {
    offset: withPageDefault(offsetLeaf, defaultOffset, fromString),
    limit: withPageDefault(limitLeaf, defaultLimit, fromString)
  } as OffsetPageFields<O>
}

const numberPage = <const O extends NumberPageOptions = {}>(options?: O): NumberPageFields<O> => {
  const { maxSize, minSize = 1, defaultSize, defaultNumber, fromString = true } = options ?? {}
  const base = fromString ? Schema.FiniteFromString : Schema.Number
  // Page numbers are 1-based.
  const numberLeaf = base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
  const sizeLeaf =
    maxSize === undefined
      ? base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(minSize))
      : base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(minSize), Schema.isLessThanOrEqualTo(maxSize))
  return {
    number: withPageDefault(numberLeaf, defaultNumber, fromString),
    size: withPageDefault(sizeLeaf, defaultSize, fromString)
  } as NumberPageFields<O>
}

/**
 * Common pagination strategies, ready to pass as the `page` query option.
 * Each key becomes a `page[<key>]` query parameter, and each
 * `Page.Offset` / `Page.Number` / `Page.Cursor` value is a
 * `Schema.Struct.Fields` whose members decode from strings.
 *
 * For configurable offset/page-number pagination — a `maxLimit` DoS guard,
 * decode defaults, and optional plain-number decoding — use the {@link Page.offset}
 * and {@link Page.number} factories instead of the constants.
 *
 * Custom strategies are plain `Schema.Struct.Fields` whose values decode from
 * strings.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * // enable offset/limit pagination on a list endpoint
 * Endpoint.list(Article, { page: Query.Page.Offset })
 *
 * // ...or a bounded, defaulted variant
 * Endpoint.list(Article, { page: Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }) })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Page = {
  /** `?page[offset]=0&page[limit]=10` */
  Offset: {
    offset: Schema.optionalKey(PageInt),
    limit: Schema.optionalKey(PageInt)
  },
  /** `?page[number]=2&page[size]=25` */
  Number: {
    number: Schema.optionalKey(PageInt),
    size: Schema.optionalKey(PageInt)
  },
  /** `?page[cursor]=opaque&page[size]=25` */
  Cursor: {
    cursor: Schema.optionalKey(Schema.String),
    size: Schema.optionalKey(PageInt)
  },
  /**
   * A configurable `{ offset, limit }` field-map: the bounded / defaulted /
   * coercion-flexible variant of {@link Page.Offset}.
   *
   * - **Bounded** — `maxLimit` caps `limit` (a DoS guard); `minLimit` (default 1) floors it.
   * - **Defaulted** — `defaultLimit` / `defaultOffset` fill in on decode when the wire key is
   *   absent, so downstream code sees concrete numbers; omit one to leave that field optional.
   * - **Coercion-flexible** — `fromString: false` builds the fields from plain `Schema.Number`
   *   (encoded = number) instead of `FiniteFromString` (encoded = string), so the same schema
   *   works both as a numeric call-site input and behind a transport that coerces query strings.
   *
   * @example
   * ```ts
   * import { Schema } from "effect"
   * import { Query } from "@thomasfosterau/effect-jsonapi"
   *
   * const page = Schema.Struct(Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }))
   * Schema.decodeUnknownSync(page)({}) // → { limit: 25 }
   * ```
   *
   * @since 0.3.0
   * @category constructors
   */
  offset: offsetPage,
  /**
   * A configurable `{ number, size }` field-map: the page-number twin of
   * {@link Page.offset}. `maxSize` / `minSize` / `defaultSize` bound and default
   * the page size; `defaultNumber` defaults the (1-based) page number.
   *
   * @example
   * ```ts
   * import { Schema } from "effect"
   * import { Query } from "@thomasfosterau/effect-jsonapi"
   *
   * const page = Schema.Struct(Query.Page.number({ maxSize: 100, defaultSize: 25 }))
   * Schema.decodeUnknownSync(page)({}) // → { size: 25 }
   * ```
   *
   * @since 0.3.0
   * @category constructors
   */
  number: numberPage
} as const

// ---------------------------------------------------------------------------
// Standalone page-key bracketing
// ---------------------------------------------------------------------------

/**
 * The struct shape {@link bracketPageKeys} accepts: any struct carrying
 * `offset` and `limit` fields, whatever else it also carries.
 *
 * @since 0.7.0
 * @category models
 */
export interface OffsetPageStruct extends Schema.Struct<Schema.Struct.Fields> {
  readonly fields: {
    readonly limit: Schema.Top
    readonly offset: Schema.Top
  }
}

/**
 * The schema {@link bracketPageKeys} returns: `S` with only its `offset` /
 * `limit` *encoded* keys renamed to the JSON:API bracket family.
 *
 * @since 0.7.0
 * @category models
 */
export interface BracketPageKeys<S extends OffsetPageStruct> extends Schema.encodeKeys<
  S,
  {
    readonly limit: "page[limit]"
    readonly offset: "page[offset]"
  }
> {}

/**
 * Re-keys a **flat** query struct's page cursor to the spec-canonical JSON:API
 * bracket family on the wire — `offset` ↔ `page[offset]`, `limit` ↔
 * `page[limit]` — leaving the decoded type, and every other field's wire key,
 * untouched.
 *
 * This is the standalone counterpart to {@link schema}'s `page` option. Where
 * `Query.schema(resource, { page })` composes the whole query (`include` /
 * `fields` / `sort` / `page` / `filter`) and *nests* the decoded cursor under a
 * `page` key, this combinator only renames two encoded keys of a struct you
 * already own — for consumers whose list-input contract merges pagination
 * **flat** alongside their own filter fields (a `{ limit, offset, … }` the rest
 * of their application consumes directly) rather than composing through
 * `Query.schema`. The bracket keys are the same family
 * {@link Handlers.offsetPaginationLinks} emits, so a client following a `next`
 * link decodes straight back into `{ offset, limit }`.
 *
 * Built on `Schema.encodeKeys`, the canonical Effect key-rename: only the
 * *encoded* side changes, so call-site inputs and handler-visible values keep
 * the flat shape. `HttpApiEndpoint` coerces the bracket leaves to and from
 * their string wire form, so a struct built from either {@link Page.Offset} or
 * the plain-number `Page.offset({ fromString: false })` factory works.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query } from "@thomasfosterau/effect-jsonapi"
 *
 * // A flat list input: pagination merged alongside an application filter.
 * const ListArticles = Schema.Struct({
 *   ...Query.Page.offset({ maxLimit: 100, fromString: false }),
 *   authorId: Schema.optionalKey(Schema.String)
 * })
 *
 * const wire = Query.bracketPageKeys(ListArticles)
 *
 * // Only the page cursor is bracketed; `authorId` keeps its flat wire key.
 * Schema.decodeUnknownSync(wire)({ "page[offset]": 20, "page[limit]": 10, authorId: "9" })
 * // → { offset: 20, limit: 10, authorId: "9" }
 * ```
 *
 * @since 0.7.0
 * @category combinators
 */
export const bracketPageKeys = <S extends OffsetPageStruct>(schema: S): BracketPageKeys<S> =>
  // The cast is sound: `BracketPageKeys<S>` extends exactly the `Schema.encodeKeys`
  // instantiation this builds, and resolves to it for every concrete `S` — but
  // the two can't be proven comparable while `S` is still generic.
  schema.pipe(Schema.encodeKeys({ limit: "page[limit]", offset: "page[offset]" })) as unknown as BracketPageKeys<S>

// ---------------------------------------------------------------------------
// Feature schemas
// ---------------------------------------------------------------------------

// Normalises "one resource or several" to an array (heterogeneous endpoints
// pass several).
const toResources = <R extends Any>(resource: R | ReadonlyArray<R>): ReadonlyArray<R> =>
  Array.isArray(resource) ? (resource as ReadonlyArray<R>) : [resource as R]

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)]

/**
 * Constrains the `include` paths an endpoint advertises.
 *
 * The default derivation is the resource's whole relationship graph to a depth
 * of 2 — a boolean "include is on". That is the right answer when every path in
 * the graph is resolvable, and the wrong one when it isn't: advertising a path
 * a resolver can't populate answers `200` with an empty `included`, which is
 * less useful to a client than the `400` an unknown path already produces.
 *
 * Pass `paths` for an explicit allow-list, `depth` to bound the derivation
 * (`1` — direct relationships only, `2` — the default, `3`), or both, in which
 * case `paths` wins.
 *
 * @since 0.9.0
 * @category models
 */
export interface IncludeOptions<R extends Any> {
  /** The exact set of legal paths. Anything else fails decoding (→ 400). */
  readonly paths?: ReadonlyArray<IncludePathsTo<R, 3>>
  /** How many hops into the relationship graph to derive. Defaults to 2. */
  readonly depth?: IncludeDepth
}

/**
 * The `include` option of a query configuration: `true` (the full graph at
 * depth 2), `false` (no `?include=` parameter), or an {@link IncludeOptions}
 * object constraining the derivation.
 *
 * @since 0.9.0
 * @category models
 */
export type IncludeOption<R extends Any> = boolean | IncludeOptions<R>

/**
 * The `include` paths an {@link IncludeOption} legalises: the explicit
 * allow-list, else the graph derived to the requested depth, else the depth-2
 * default.
 *
 * @since 0.9.0
 * @category type-level
 */
export type IncludePathsOf<R extends Any, I> = Extract<
  I extends { readonly paths: ReadonlyArray<infer P> }
    ? P
    : I extends { readonly depth: infer D }
      ? D extends IncludeDepth
        ? IncludePathsTo<R, D>
        : IncludePath<R>
      : IncludePath<R>,
  string
>

/**
 * The decoded `include` schema: a comma-separated list of relationship paths,
 * typed as the resource's legal path literals (2 hops into the relationship
 * graph, unless constrained) and validated at decode time.
 *
 * @since 0.1.0
 * @category models
 */
export interface Include<R extends Any, Paths extends string = IncludePath<R>> extends CommaSeparated<
  Schema.Literals<ReadonlyArray<Paths>>
> {}

// The paths an `include` schema legalises, at runtime.
const includePathsFor = (
  resources: ReadonlyArray<Any>,
  options: IncludeOptions<Any> | undefined
): ReadonlyArray<string> =>
  options?.paths !== undefined
    ? dedupe(options.paths as ReadonlyArray<string>)
    : dedupe(resources.flatMap((r) => includePaths(r, options?.depth ?? 2)))

/**
 * Creates the `include` schema for one resource (or, for heterogeneous
 * endpoints, several). Paths default to the relationship keys plus dotted paths
 * one further hop into the graph; anything else fails decoding (→ 400).
 *
 * Pass {@link IncludeOptions} to constrain that set — an explicit `paths`
 * allow-list, or a `depth` bound — for resources whose graph reaches further
 * than the endpoint can actually resolve.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     comments: Relationship.many(() => Comment)
 *   }
 * })
 *
 * const include = Query.Include(Article)
 * Schema.decodeUnknownSync(include)("author,comments.author")
 * // → ["author", "comments.author"]
 *
 * // …or a deliberate subset: only the paths this endpoint can populate
 * const shallow = Query.Include(Article, { paths: ["author", "comments"] })
 * Schema.decodeUnknownSync(shallow)("author,comments")
 * // → ["author", "comments"]
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Include = <R extends Any, const O extends IncludeOptions<R> | undefined = undefined>(
  resource: R | ReadonlyArray<R>,
  options?: O
): Include<R, IncludePathsOf<R, O>> =>
  CommaSeparated(
    Schema.Literals(
      includePathsFor(toResources(resource), options as IncludeOptions<Any> | undefined) as ReadonlyArray<
        IncludePathsOf<R, O>
      >
    )
  )

/**
 * The decoded sparse-fieldset schema for one resource type: a comma-separated
 * list of attribute names, validated against the closed attribute set.
 *
 * @since 0.1.0
 * @category models
 */
export interface Fieldset<Field extends string> extends CommaSeparated<Schema.Literals<ReadonlyArray<Field>>> {}

/**
 * Creates the sparse-fieldset schema for one resource type.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * const fieldset = Query.Fieldset(Article)
 * Schema.decodeUnknownSync(fieldset)("title,body")
 * // → ["title", "body"]
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Fieldset = <R extends Any>(resource: R): Fieldset<AttributeKeys<R>> =>
  CommaSeparated(Schema.Literals(attributeKeys(resource) as ReadonlyArray<AttributeKeys<R>>))

/**
 * The decoded `sort` schema: a list of `{ field, direction }` terms.
 *
 * @since 0.1.0
 * @category models
 */
export interface Sort<Field extends string> extends SortCodec<Field> {}

/**
 * Creates the `sort` schema for a set of sortable fields.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query } from "@thomasfosterau/effect-jsonapi"
 *
 * const sort = Query.Sort(["createdAt", "title"])
 * Schema.decodeUnknownSync(sort)("-createdAt,title")
 * // → [{ field: "createdAt", direction: "desc" },
 * //    { field: "title", direction: "asc" }]
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Sort = <const Field extends string>(fields: ReadonlyArray<Field>): Sort<Field> => SortCodec(fields)

// ---------------------------------------------------------------------------
// The filter codec (docs/filter-grammar.md)
// ---------------------------------------------------------------------------

/**
 * The JSON:API profile URI of the filter grammar — `Filter.PROFILE_URI`,
 * re-exported for the query module's consumers. Advertise it on responses
 * from endpoints declared with `filter: true`:
 * `Content-Type: application/vnd.api+json; profile="…"`.
 *
 * @since 0.13.0
 * @category constants
 */
export const FILTER_PROFILE_URI: typeof PROFILE_URI = PROFILE_URI

/**
 * The field vocabulary of a resource's filter AST: each key
 * `Resource.filterable` declares, to its decoded literal type (the attribute's
 * `Type`, or the related resource's id for a to-one relationship).
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterFields<R extends Any> = {
  readonly [K in FilterableKeys<R>]: Filterable<R>[K]["literal"]["Type"]
}

/**
 * The decoded `filter` of a resource: `Filter.Ast` with `field` narrowed to
 * the declared filterable names and each literal to its field's type.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterAst<R extends Any> = Ast<FilterFields<R>>

/**
 * The schema of a decoded {@link FilterAst} as it sits in a query's nested
 * shape (the `filter` key of `Query.schema(R, { filter: true })`): the tree
 * is already decoded, so both sides are the AST.
 *
 * @since 0.13.0
 * @category models
 */
export interface FilterAstSchema<R extends Any> extends Schema.Codec<FilterAst<R>, FilterAst<R>> {}

/**
 * The `filter[...]` codec of a resource: the flat record of `filter[...]`
 * keys (string values) on the wire, one {@link FilterAst} root node decoded.
 *
 * @since 0.13.0
 * @category models
 */
export interface Filter<R extends Any> extends Schema.Codec<FilterAst<R>, { readonly [key: string]: string }> {}

/**
 * The wire value of one `filter` family key: a string, or — from a repeated
 * key — an array of strings, which the codec then rejects (only `include` is
 * repeatable). Kept open at this level so the rejection names the key.
 *
 * @since 0.13.0
 * @category models
 */
export interface FilterWireValue extends Schema.Union<readonly [Schema.String, Schema.$Array<Schema.String>]> {}

/**
 * The runtime {@link FilterWireValue} schema.
 *
 * @since 0.13.0
 * @category schemas
 */
export const FilterWireValue: FilterWireValue = Schema.Union([Schema.String, Schema.Array(Schema.String)])

// Every key starting `filter[` — well formed or not, so a malformed key
// (`filter[status]x`) reaches the grammar and is rejected, never silently
// dropped as an excess property. The bare `filter` key is a flat struct field
// of its own for the same reason.
const FilterKey = Schema.TemplateLiteral(["filter[", Schema.String])

/**
 * The wire side of the filter family when `filter: true` is on: every key
 * starting `filter[`, valued by a {@link FilterWireValue}. The index-signature
 * rest of the flat query struct; the keys cannot be enumerated because the
 * grammar admits any group-form id, and they are deliberately not required to
 * be well formed, so that a malformed one is a 400 naming it rather than an
 * ignored excess property.
 *
 * @since 0.13.0
 * @category models
 */
export interface FilterRest extends Schema.$Record<typeof FilterKey, FilterWireValue> {}

/**
 * The runtime {@link FilterRest} record schema.
 *
 * @since 0.13.0
 * @category schemas
 */
export const FilterRest: FilterRest = Schema.Record(FilterKey, FilterWireValue)

// One issue per offending key, or a `Composite` of them when several keys fail.
const filterIssues = (
  ast: SchemaAST.AST,
  input: unknown,
  issues: ReadonlyArray<SchemaIssue.Issue>,
  options: SchemaAST.ParseOptions
): SchemaIssue.Issue =>
  issues.length === 1
    ? issues[0]!
    : new SchemaIssue.Composite(ast, issues as [SchemaIssue.Issue, ...Array<SchemaIssue.Issue>], input, options)

// Decodes a record of `filter[...]` keys to a normal-form tree.
const decodeFilterRecord = (
  fields: FieldCodecs,
  ast: SchemaAST.AST,
  input: { readonly [key: string]: unknown },
  options: SchemaAST.ParseOptions
): Effect.Effect<Node, SchemaIssue.Issue> => {
  const decoded = decodeFilter(fields, input)
  if (decoded._tag === "Issues") return Effect.fail(filterIssues(ast, input, decoded.issues, options))
  try {
    return Effect.succeed(prepare(decoded.node, literalEncoder(fields)).node)
  } catch (error) {
    return Effect.fail(new SchemaIssue.InvalidValue({ message: messageOf(error) }, input, options))
  }
}

// Encodes a tree (normalising it first, and checking every field and operator
// against the declaration) to its canonical `filter[...]` pairs.
const encodeFilterNode = (
  fields: FieldCodecs,
  node: Node,
  options: SchemaAST.ParseOptions
): Effect.Effect<Record<string, string>, SchemaIssue.Issue> => {
  try {
    return Effect.succeed(encodeFilter(prepare(node, literalEncoder(fields), operatorCheck(fields))))
  } catch (error) {
    return Effect.fail(new SchemaIssue.InvalidValue({ message: messageOf(error) }, node, options))
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Creates the `filter` codec for one resource: the filter grammar
 * (`docs/filter-grammar.md`) over the resource's declaration
 * (`Resource.filterable`), between the flat record of `filter[...]` keys on
 * the wire and one decoded, normal-form AST root.
 *
 * Decoding accepts both spellings — the shorthand (`filter[f]=v` is `eq`,
 * `filter[f]=a,b` is `in`, `filter[f][gt]=v` any operator) and the Drupal-style
 * group form (`filter[<id>][group][conjunction]=OR`,
 * `filter[<id>][condition][path]=…`) for `OR`, `NOT`, nesting and repeated
 * `(field, operator)` pairs — validating each field against the declared set,
 * each operator against the field's declared operators, and each literal
 * through the field's literal codec. Every rejection is one issue whose path
 * is the offending flat key, so the schema-error middleware answers with
 * `source.parameter` set to it. Encoding always emits the canonical form
 * (§3): shorthand when it round-trips, the group form with pre-order ids
 * otherwise; the returned record's insertion order is the canonical order.
 *
 * The record must carry at least one `filter[...]` key — an absent `filter`
 * is `Query.schema`'s concern, not the codec's. Literal codecs are run
 * synchronously.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     status: Resource.attribute(Schema.Literals(["open", "done"]), { filter: ["eq", "in"] }),
 *     age: Resource.attribute(Schema.Number, { filter: true })
 *   }
 * })
 *
 * const filter = Query.Filter(Article)
 * Schema.decodeUnknownSync(filter)({ "filter[status]": "open", "filter[age][gt]": "18" })
 * // → { _tag: "And", members: [
 * //      { _tag: "Compare", op: "gt", field: "age", value: 18 },
 * //      { _tag: "Compare", op: "eq", field: "status", value: "open" } ] }
 *
 * Schema.encodeSync(filter)({ _tag: "Compare", op: "eq", field: "status", value: "done" })
 * // → { "filter[status]": "done" }
 * ```
 *
 * @since 0.13.0
 * @category constructors
 */
export const Filter = <R extends Any>(resource: R): Filter<R> => {
  const fields = filterable(resource) as FieldCodecs
  const from = Schema.Record(Schema.String, FilterWireValue)
  return from.pipe(
    Schema.decodeTo(
      AstSchema,
      SchemaTransformation.transformOrFail<Node, { readonly [key: string]: string | ReadonlyArray<string> }>({
        decode: (record, options) => decodeFilterRecord(fields, from.ast, record, options),
        encode: (node, options) => encodeFilterNode(fields, node, options)
      })
    )
  ) as unknown as Filter<R>
}

// ---------------------------------------------------------------------------
// The combined query schema
// ---------------------------------------------------------------------------

/**
 * The `filter` option of a query configuration: `true` turns on the filter
 * grammar over the resource's declaration (decoding to a {@link FilterAst});
 * a `Schema.Struct.Fields` map is the open per-key escape hatch (each key
 * becomes `filter[<key>]`, its schema decoding from a string); `false` or
 * absent is off.
 *
 * @since 0.13.0
 * @category models
 */
export type FilterOption = boolean | Schema.Struct.Fields

/**
 * Query feature configuration for an endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options<R extends Any> {
  /**
   * Enable `?include=` — compound document inclusion. `true` legalises the
   * resource's whole relationship graph to a depth of 2; an
   * {@link IncludeOptions} object constrains that to an explicit `paths`
   * allow-list and/or a `depth` bound. Paths are validated against the result;
   * unknown paths produce a 400.
   *
   * Both wire spellings are accepted — `?include=a,b` and `?include=a&include=b`
   * — and decode to the same set.
   */
  readonly include?: IncludeOption<R>
  /**
   * Enable `?fields[TYPE]=` — sparse fieldsets for this resource and its
   * direct relationship targets. Unknown field names produce a 400.
   */
  readonly fields?: boolean
  /**
   * Enable `?sort=` — `true` allows sorting on every attribute; pass an array
   * of attribute names to restrict the sortable set. Unknown fields produce a 400.
   */
  readonly sort?: boolean | ReadonlyArray<AttributeKeys<R>>
  /**
   * Enable `?page[*]=` pagination. Pass one of the {@link Page} strategies or
   * custom `Schema.Struct.Fields` (each key becomes `page[<key>]`).
   */
  readonly page?: Schema.Struct.Fields
  /**
   * Enable `?filter[*]=` filtering. `true` turns on the filter grammar
   * (`docs/filter-grammar.md`) over the resource's declared filterable fields
   * — `filter[f]=v` is `eq`, `filter[f]=a,b` is `in`, `filter[f][gt]=v` any
   * operator, plus the group form for `OR` / `NOT` / nesting — decoding to a
   * {@link FilterAst}; unknown fields, undeclared operators and bad literals
   * produce a 400 naming the key. A single resource only: a heterogeneous
   * endpoint must use the map form.
   *
   * A `Schema.Struct.Fields` map is the open per-key escape hatch for flags
   * JSON:API has no family for: each key becomes `filter[<key>]` and its
   * schema must decode from a string.
   */
  readonly filter?: FilterOption
}

/**
 * Resource definitions whose sparse fieldsets appear in `?fields[TYPE]=`:
 * the resource(s) themselves plus their direct relationship targets.
 *
 * Distributes over unions of resource definitions.
 *
 * @since 0.1.0
 * @category type-level
 */
export type FieldsetResources<R extends Any> = R extends Any ? R | RelationshipTargets<R["relationships"]> : never

// Whether an `include` option turns the parameter on: `true`, or an
// `IncludeOptions` object. Everything else (`false`, absent) leaves it off.
type IncludeEnabled<I> = [I] extends [true] ? true : [I] extends [object] ? true : false

/**
 * The nested (decoded) struct fields of a query schema.
 *
 * @since 0.1.0
 * @category type-level
 */
export type NestedFields<R extends Any, O extends Options<R>> = Types.Simplify<
  (IncludeEnabled<O["include"]> extends true
    ? { readonly include: Schema.optionalKey<Include<R, IncludePathsOf<R, O["include"]>>> }
    : {}) &
    ([O["fields"]] extends [true]
      ? {
          readonly fields: Schema.optionalKey<
            Schema.Struct<{
              readonly [TypeName in FieldsetResources<R>["type"]]: Schema.optionalKey<
                Fieldset<AttributeKeys<Extract<FieldsetResources<R>, { type: TypeName }>>>
              >
            }>
          >
        }
      : {}) &
    (O["sort"] extends true
      ? { readonly sort: Schema.optionalKey<Sort<AttributeKeys<R>>> }
      : O["sort"] extends ReadonlyArray<string>
        ? { readonly sort: Schema.optionalKey<Sort<O["sort"][number]>> }
        : {}) &
    (O["page"] extends Schema.Struct.Fields ? { readonly page: Schema.optionalKey<Schema.Struct<O["page"]>> } : {}) &
    ([O["filter"]] extends [true]
      ? { readonly filter: Schema.optionalKey<FilterAstSchema<R>> }
      : O["filter"] extends Schema.Struct.Fields
        ? { readonly filter: Schema.optionalKey<Schema.Struct<O["filter"]>> }
        : {})
>

/**
 * The flat (wire) struct fields of a query schema: every parameter is a
 * bracket-keyed string. The grammar's `filter[...]` keys (`filter: true`)
 * are not enumerable and live in the struct's {@link FilterRest} instead;
 * only the bare `filter` key is a field, so that it is rejected, not ignored.
 *
 * @since 0.1.0
 * @category type-level
 */
export type FlatFields<R extends Any, O extends Options<R>> = Types.Simplify<
  (IncludeEnabled<O["include"]> extends true ? { readonly include: Schema.optionalKey<Repeatable> } : {}) &
    ([O["fields"]] extends [true]
      ? {
          readonly [TypeName in FieldsetResources<R>["type"] as `fields[${TypeName}]`]: Schema.optionalKey<Schema.String>
        }
      : {}) &
    (O["sort"] extends true | ReadonlyArray<string> ? { readonly sort: Schema.optionalKey<Schema.String> } : {}) &
    (O["page"] extends Schema.Struct.Fields
      ? {
          readonly [K in keyof O["page"] & string as `page[${K}]`]: Schema.optionalKey<Schema.String>
        }
      : {}) &
    ([O["filter"]] extends [true]
      ? { readonly filter: Schema.optionalKey<FilterWireValue> }
      : O["filter"] extends Schema.Struct.Fields
        ? {
            readonly [K in keyof O["filter"] & string as `filter[${K}]`]: Schema.optionalKey<Schema.String>
          }
        : {})
>

// Resolves to `T` for every concrete query configuration; needed because the
// conditional intersections above can't be proven to satisfy `Struct.Fields`
// while `O` is still generic.
type AsFields<T> = T extends Schema.Struct.Fields ? T : never

/**
 * The flat (wire) schema of a query: the bracket-keyed struct of
 * {@link FlatFields}, extended with the {@link FilterRest} index signature
 * when `filter: true` is on.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FlatSchema<R extends Any, O extends Options<R>> = [O["filter"]] extends [true]
  ? Schema.StructWithRest<Schema.Struct<AsFields<FlatFields<R, O>>>, readonly [FilterRest]>
  : Schema.Struct<AsFields<FlatFields<R, O>>>

/**
 * The full query schema for a resource and feature set: a flat, bracket-keyed
 * string record on the wire, an ergonomic nested shape when decoded.
 *
 * @since 0.1.0
 * @category models
 */
export interface QuerySchema<R extends Any, O extends Options<R>> extends Schema.decodeTo<
  Schema.Struct<AsFields<NestedFields<R, O>>>,
  FlatSchema<R, O>,
  never,
  never
> {}

/**
 * Builds the query schema for a resource (or, for heterogeneous endpoints,
 * several resources) and a feature set.
 *
 * The result is passed as an `HttpApiEndpoint` `query` schema; handlers
 * receive the decoded nested shape, clients provide it and it is encoded back
 * to flat query parameters.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * const query = Query.schema(Article, {
 *   include: true,
 *   fields: true,
 *   sort: true,
 *   page: Query.Page.Offset,
 *   filter: { author: Schema.String }
 * })
 *
 * // handlers receive the decoded nested shape
 * Schema.decodeUnknownSync(query)({ "page[offset]": "20", "page[limit]": "10" })
 * // → { page: { offset: 20, limit: 10 } }
 *
 * // `filter: true` — the filter grammar over the resource's declaration
 * const Product = Resource.make("products", {
 *   attributes: { priceCents: Resource.attribute(Schema.Int, { filter: true }) }
 * })
 * const filtered = Query.schema(Product, { filter: true, page: Query.Page.Offset })
 * Schema.decodeUnknownSync(filtered)({ "filter[priceCents][lt]": "1000", "page[limit]": "10" })
 * // → { filter: { _tag: "Compare", op: "lt", field: "priceCents", value: 1000 }, page: { limit: 10 } }
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const schema = <R extends Any, const O extends Options<R>>(
  resource: R | ReadonlyArray<R>,
  options: O
): QuerySchema<R, O> => {
  const resources = toResources(resource)
  const nestedFields: Record<string, Schema.Top> = {}
  const flatFields: Record<string, Schema.Top> = {}

  const include = options.include
  if (include === true || typeof include === "object") {
    nestedFields.include = Schema.optionalKey(
      Include(resources, (typeof include === "object" ? include : undefined) as never)
    )
    flatFields.include = Schema.optionalKey(Repeatable)
  }

  if (options.fields === true) {
    const fieldsetFields: Record<string, Schema.Top> = {}
    for (const target of dedupe([...resources, ...resources.flatMap(allTargets)])) {
      fieldsetFields[target.type] = Schema.optionalKey(Fieldset(target))
      flatFields[`fields[${target.type}]`] = Schema.optionalKey(Schema.String)
    }
    nestedFields.fields = Schema.optionalKey(Schema.Struct(fieldsetFields))
  }

  if (options.sort === true || (Array.isArray(options.sort) && options.sort.length > 0)) {
    const sortable =
      options.sort === true
        ? dedupe(resources.flatMap((r) => attributeKeys(r)))
        : (options.sort as ReadonlyArray<string>)
    nestedFields.sort = Schema.optionalKey(Sort(sortable))
    flatFields.sort = Schema.optionalKey(Schema.String)
  }

  if (options.page !== undefined) {
    nestedFields.page = Schema.optionalKey(Schema.Struct(options.page))
    for (const key of Object.keys(options.page)) {
      flatFields[`page[${key}]`] = Schema.optionalKey(Schema.String)
    }
  }

  // The grammar's field declaration, when `filter: true` is on.
  let filterFields: FieldCodecs | undefined
  if (options.filter === true) {
    if (resources.length !== 1) {
      throw new Error(
        "Query.schema: `filter: true` derives the filter grammar from one resource's declaration; " +
          "a heterogeneous endpoint (several resources) must use the per-key `filter: { … }` map instead"
      )
    }
    filterFields = filterable(resources[0]!) as FieldCodecs
    nestedFields.filter = Schema.optionalKey(AstSchema)
    // The bare `filter` key is malformed under the grammar; declared here so
    // it reaches the grammar's rejection rather than being dropped.
    flatFields.filter = Schema.optionalKey(FilterWireValue)
  } else if (typeof options.filter === "object") {
    nestedFields.filter = Schema.optionalKey(Schema.Struct(options.filter))
    for (const key of Object.keys(options.filter)) {
      flatFields[`filter[${key}]`] = Schema.optionalKey(Schema.String)
    }
  }

  const flatStruct = Schema.Struct(flatFields)
  const flat = filterFields === undefined ? flatStruct : Schema.StructWithRest(flatStruct, [FilterRest])
  const nested = Schema.Struct(nestedFields)
  const fields = filterFields

  type Values = { readonly [x: string]: unknown }
  return flat.pipe(
    Schema.decodeTo(
      nested,
      fields === undefined
        ? SchemaTransformation.transform<Values, Values>({
            decode: (flatValues) => nest(flatValues),
            encode: (nestedValues) => flatten(nestedValues)
          })
        : // `filter[...]` keys are routed to the grammar ahead of the one-level
          // bracket reshaper, so `page[*]` / `fields[*]` are untouched.
          SchemaTransformation.transformOrFail<Values, Values>({
            decode: (flatValues, parseOptions) => {
              const others: Record<string, unknown> = {}
              const filterKeys: Record<string, unknown> = {}
              for (const [key, value] of Object.entries(flatValues)) {
                if (isFilterKey(key)) filterKeys[key] = value
                else others[key] = value
              }
              const nestedValues = nest(others)
              if (Object.keys(filterKeys).length === 0) return Effect.succeed(nestedValues)
              return Effect.map(decodeFilterRecord(fields, flat.ast, filterKeys, parseOptions), (filter) => ({
                ...nestedValues,
                filter
              }))
            },
            encode: (nestedValues, parseOptions) => {
              const { filter, ...others } = nestedValues
              const flatValues = flatten(others)
              if (filter === undefined) return Effect.succeed(flatValues)
              return Effect.map(encodeFilterNode(fields, filter as Node, parseOptions), (pairs) => ({
                ...flatValues,
                ...pairs
              }))
            }
          })
    )
  ) as unknown as QuerySchema<R, O>
}

// ---------------------------------------------------------------------------
// The canonical query string
// ---------------------------------------------------------------------------

/**
 * One flat `(key, value)` query pair, both sides un-encoded — what
 * {@link canonicalPairs} produces and {@link serialise} consumes.
 *
 * @since 0.13.0
 * @category models
 */
export type Pair = CanonicalPair

/**
 * A query schema {@link canonical} accepts: any codec whose encoded (wire)
 * side is a flat, string-keyed record and whose encoder needs no services —
 * a {@link schema} result, or a consumer's own flat query struct
 * ({@link bracketPageKeys}, say).
 *
 * Each encoded value must have a wire form that decodes back through the
 * same schema: a string, or something `String()` renders faithfully (a
 * number, a boolean). An array is emitted as the repeated key, one pair per
 * item (`tag=a&tag=b`, which `UrlParams.toRecord` decodes back to an
 * array), except `include`, whose comma form is its own encoding. `null`
 * has no wire form and is omitted, like `undefined` — a nullable field
 * round-trips only if its schema decodes an absent key to `null`.
 *
 * @since 0.13.0
 * @category models
 */
export interface FlatQuerySchema extends Schema.Codec<unknown, { readonly [key: string]: unknown }, unknown, never> {}

/**
 * Serialises ordered query pairs to a query string (no leading `?`): every
 * key and value RFC 3986 percent-encoded with `encodeURIComponent` — spaces
 * are `%20`, never `+`; commas `%2C` — except that `[` and `]` are left
 * readable in keys, and pairs joined with `&`. The result is what
 * `Handlers.offsetPaginationLinks` and its siblings emit:
 * `page[offset]=0&page[limit]=10`.
 *
 * Commas are encoded even where they separate a list (`include=a%2Cb`,
 * `filter[f]=a%2Cb`) and where the filter grammar escapes one (`\,` is
 * `%5C%2C`): the encoding is uniform and `URLSearchParams` / `UrlParams`
 * decode it back to the same record byte for byte, so the string decodes
 * through the same query schema.
 *
 * @example
 * ```ts
 * import { Query } from "@thomasfosterau/effect-jsonapi"
 *
 * Query.serialise([
 *   ["include", "author,comments"],
 *   ["filter[title]", "Hello, world"],
 *   ["page[offset]", "0"]
 * ])
 * // → "include=author%2Ccomments&filter[title]=Hello%2C%20world&page[offset]=0"
 * ```
 *
 * @since 0.13.0
 * @category utils
 */
export const serialise: (pairs: Iterable<Pair>) => string = serialisePairs

/**
 * The canonically ordered flat pairs of a decoded query — {@link canonical}
 * before serialisation, for callers that assemble the string themselves
 * (the pagination link builders take these as their `query` option and slot
 * the page cursor in).
 *
 * The query is encoded through `schema`, then its pairs are ordered by one
 * rule:
 *
 * 1. `include`
 * 2. `fields[*]`, sorted by type (code-point order)
 * 3. `filter[*]`, in the filter grammar's canonical order (`docs/filter-grammar.md`
 *    §3.3): shorthand keys sorted by key (code-point order), which is also
 *    how the per-key `filter: { … }` escape hatch is ordered; the group form
 *    in the encoder's pre-order, whose ids are meaningful and never re-sorted
 * 4. `sort`
 * 5. `page[*]`, in the order the page strategy declares its keys — `offset,
 *    limit` / `number, size` / `cursor, size` — the order the pagination link
 *    builders emit, so a `self` link and the canonical string agree
 * 6. any other key (a consumer's own flat schema), sorted by key
 *
 * An absent (`undefined` or `null`) value is omitted, an empty string is
 * kept (`key=`), and an array is the repeated key, one pair per item in
 * order (`include` excepted: its comma form) — see {@link FlatQuerySchema}.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 * const query = Query.schema(Article, { fields: true, sort: true, page: Query.Page.Offset })
 *
 * Query.canonicalPairs(query)({
 *   page: { limit: 10, offset: 0 },
 *   sort: [{ field: "title", direction: "desc" }],
 *   fields: { articles: ["title"] }
 * })
 * // → [["fields[articles]", "title"], ["sort", "-title"], ["page[offset]", "0"], ["page[limit]", "10"]]
 * ```
 *
 * @since 0.13.0
 * @category utils
 */
export const canonicalPairs = <S extends FlatQuerySchema>(schema: S): ((decoded: S["Type"]) => ReadonlyArray<Pair>) => {
  const encode = Schema.encodeSync(schema)
  const declared = declaredKeys(schema.ast)
  return (decoded) => orderPairs(encode(decoded) as { readonly [key: string]: unknown }, declared)
}

/**
 * The canonical query string of a decoded query: encoded through `schema`,
 * ordered by {@link canonicalPairs}'s one rule (`include`, `fields[*]`,
 * `filter[*]`, `sort`, `page[*]`, then anything else) and serialised by
 * {@link serialise}.
 *
 * Two decoded queries that are equal produce byte-identical strings whatever
 * the wire spelling they came from — key order, `?include=a&include=b`
 * against `?include=a,b`, `filter[f][eq]=v` against `filter[f]=v` — and the
 * string decodes back to the same query through the same schema (an array
 * value is the repeated key, `null` is omitted; see {@link FlatQuerySchema}).
 * It is what a collection document's `self` link carries (JSON:API 1.1
 * requires the query parameters the client provided) and a stable identity
 * for a query: a subscription, a cache tag. A paginated `self` link also
 * carries the page defaults the server applied — the effective page window —
 * see `Handlers.offsetPaginationLinks`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     title: Schema.NonEmptyString,
 *     status: Resource.attribute(Schema.Literals(["open", "done"]), { filter: true })
 *   }
 * })
 * const query = Query.schema(Article, { fields: true, sort: true, page: Query.Page.Offset, filter: true })
 * const canonical = Query.canonical(query)
 *
 * canonical({
 *   page: { limit: 10, offset: 0 },
 *   filter: { _tag: "Compare", op: "eq", field: "status", value: "open" },
 *   sort: [{ field: "title", direction: "desc" }]
 * })
 * // → "filter[status]=open&sort=-title&page[offset]=0&page[limit]=10"
 *
 * // the same query decoded from any spelling canonicalises identically
 * const decoded = Schema.decodeUnknownSync(query)({
 *   "page[limit]": "10",
 *   sort: "-title",
 *   "filter[status][eq]": "open",
 *   "page[offset]": "0"
 * })
 * canonical(decoded)
 * // → "filter[status]=open&sort=-title&page[offset]=0&page[limit]=10"
 * ```
 *
 * @since 0.13.0
 * @category utils
 */
export const canonical = <S extends FlatQuerySchema>(schema: S): ((decoded: S["Type"]) => string) => {
  const pairs = canonicalPairs(schema)
  return (decoded) => serialisePairs(pairs(decoded))
}
