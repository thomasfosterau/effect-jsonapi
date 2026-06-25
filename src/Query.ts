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
 *   - `filter`    — filtering (`?filter[author]=9`, shape is user-defined)
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
 *   filter?:  { author?: string }
 * }
 * ```
 *
 * Illegal values (unknown include paths, unknown sparse-fieldset names,
 * unknown sort fields) fail decoding, which HttpApi surfaces as a 400 — the
 * spec-compliant response.
 *
 * @since 0.1.0
 */
import type { Types } from "effect"
import { Effect, Schema, SchemaTransformation } from "effect"
import { CommaSeparated, flatten, nest, Sort as SortCodec } from "./internal/codecs.js"
import type { Any, AttributeKeys, IncludePath, RelationshipTargets } from "./Resource.js"
import { allTargets, attributeKeys, includePaths } from "./Resource.js"

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
// Feature schemas
// ---------------------------------------------------------------------------

// Normalises "one resource or several" to an array (heterogeneous endpoints
// pass several).
const toResources = <R extends Any>(resource: R | ReadonlyArray<R>): ReadonlyArray<R> =>
  Array.isArray(resource) ? (resource as ReadonlyArray<R>) : [resource as R]

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)]

/**
 * The decoded `include` schema: a comma-separated list of relationship paths,
 * typed as the resource's legal path literals (2 hops into the relationship
 * graph) and validated at decode time.
 *
 * @since 0.1.0
 * @category models
 */
export interface Include<R extends Any> extends CommaSeparated<Schema.Literals<ReadonlyArray<IncludePath<R>>>> {}

/**
 * Creates the `include` schema for one resource (or, for heterogeneous
 * endpoints, several). Paths are the relationship keys plus dotted paths one
 * further hop into the graph; anything else fails decoding (→ 400).
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
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Include = <R extends Any>(resource: R | ReadonlyArray<R>): Include<R> =>
  CommaSeparated(
    Schema.Literals(dedupe(toResources(resource).flatMap((r) => includePaths(r, 2))) as ReadonlyArray<IncludePath<R>>)
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
// The combined query schema
// ---------------------------------------------------------------------------

/**
 * Query feature configuration for an endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options<R extends Any> {
  /**
   * Enable `?include=` — compound document inclusion. Paths are validated
   * against the resource's relationship graph; unknown paths produce a 400.
   */
  readonly include?: boolean
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
   * Enable `?filter[*]=` filtering. The spec leaves filtering semantics to the
   * implementation; each key becomes `filter[<key>]` and its schema must
   * decode from a string.
   */
  readonly filter?: Schema.Struct.Fields
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

/**
 * The nested (decoded) struct fields of a query schema.
 *
 * @since 0.1.0
 * @category type-level
 */
export type NestedFields<R extends Any, O extends Options<R>> = Types.Simplify<
  ([O["include"]] extends [true] ? { readonly include: Schema.optionalKey<Include<R>> } : {}) &
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
    (O["filter"] extends Schema.Struct.Fields
      ? { readonly filter: Schema.optionalKey<Schema.Struct<O["filter"]>> }
      : {})
>

/**
 * The flat (wire) struct fields of a query schema: every parameter is a
 * bracket-keyed string.
 *
 * @since 0.1.0
 * @category type-level
 */
export type FlatFields<R extends Any, O extends Options<R>> = Types.Simplify<
  ([O["include"]] extends [true] ? { readonly include: Schema.optionalKey<Schema.String> } : {}) &
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
    (O["filter"] extends Schema.Struct.Fields
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
 * The full query schema for a resource and feature set: a flat, bracket-keyed
 * string record on the wire, an ergonomic nested shape when decoded.
 *
 * @since 0.1.0
 * @category models
 */
export interface QuerySchema<R extends Any, O extends Options<R>> extends Schema.decodeTo<
  Schema.Struct<AsFields<NestedFields<R, O>>>,
  Schema.Struct<AsFields<FlatFields<R, O>>>,
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

  if (options.include === true) {
    nestedFields.include = Schema.optionalKey(Include(resources))
    flatFields.include = Schema.optionalKey(Schema.String)
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

  if (options.filter !== undefined) {
    nestedFields.filter = Schema.optionalKey(Schema.Struct(options.filter))
    for (const key of Object.keys(options.filter)) {
      flatFields[`filter[${key}]`] = Schema.optionalKey(Schema.String)
    }
  }

  const flat = Schema.Struct(flatFields)
  const nested = Schema.Struct(nestedFields)

  return flat.pipe(
    Schema.decodeTo(
      nested,
      SchemaTransformation.transform<{ readonly [x: string]: unknown }, { readonly [x: string]: unknown }>({
        decode: (flatValues) => nest(flatValues),
        encode: (nestedValues) => flatten(nestedValues)
      })
    )
  ) as unknown as QuerySchema<R, O>
}
