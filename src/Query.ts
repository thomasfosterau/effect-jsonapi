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
 */
import type { Types } from "effect"
import { Schema, SchemaTransformation } from "effect"
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
  }
} as const

// ---------------------------------------------------------------------------
// Feature schemas
// ---------------------------------------------------------------------------

// Normalises "one resource or several" to an array (heterogeneous endpoints
// pass several).
const toResources = <R extends Any>(resource: R | ReadonlyArray<R>): ReadonlyArray<R> =>
  Array.isArray(resource) ? resource as ReadonlyArray<R> : [resource as R]

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)]

/**
 * The decoded `include` schema: a comma-separated list of relationship paths,
 * typed as the resource's legal path literals (2 hops into the relationship
 * graph) and validated at decode time.
 */
export interface Include<R extends Any> extends
  CommaSeparated<Schema.Literals<ReadonlyArray<IncludePath<R>>>>
{}

/**
 * Creates the `include` schema for one resource (or, for heterogeneous
 * endpoints, several). Paths are the relationship keys plus dotted paths one
 * further hop into the graph; anything else fails decoding (→ 400).
 */
export const Include = <R extends Any>(resource: R | ReadonlyArray<R>): Include<R> =>
  CommaSeparated(
    Schema.Literals(
      dedupe(toResources(resource).flatMap((r) => includePaths(r, 2))) as ReadonlyArray<IncludePath<R>>
    )
  )

/**
 * The decoded sparse-fieldset schema for one resource type: a comma-separated
 * list of attribute names, validated against the closed attribute set.
 */
export interface Fieldset<Field extends string> extends
  CommaSeparated<Schema.Literals<ReadonlyArray<Field>>>
{}

/**
 * Creates the sparse-fieldset schema for one resource type.
 */
export const Fieldset = <R extends Any>(resource: R): Fieldset<AttributeKeys<R>> =>
  CommaSeparated(Schema.Literals(attributeKeys(resource) as ReadonlyArray<AttributeKeys<R>>))

/**
 * The decoded `sort` schema: a list of `{ field, direction }` terms.
 */
export interface Sort<Field extends string> extends SortCodec<Field> {}

/**
 * Creates the `sort` schema for a set of sortable fields.
 */
export const Sort = <const Field extends string>(fields: ReadonlyArray<Field>): Sort<Field> => SortCodec(fields)

// ---------------------------------------------------------------------------
// The combined query schema
// ---------------------------------------------------------------------------

/**
 * Query feature configuration for an endpoint.
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
 */
export type FieldsetResources<R extends Any> = R extends Any ? R | RelationshipTargets<R["relationships"]>
  : never

/**
 * The nested (decoded) struct fields of a query schema.
 */
export type NestedFields<R extends Any, O extends Options<R>> = Types.Simplify<
  & ([O["include"]] extends [true] ? { readonly include: Schema.optionalKey<Include<R>> } : {})
  & ([O["fields"]] extends [true] ? {
      readonly fields: Schema.optionalKey<
        Schema.Struct<
          {
            readonly [TypeName in FieldsetResources<R>["type"]]: Schema.optionalKey<
              Fieldset<AttributeKeys<Extract<FieldsetResources<R>, { type: TypeName }>>>
            >
          }
        >
      >
    }
    : {})
  & (O["sort"] extends true ? { readonly sort: Schema.optionalKey<Sort<AttributeKeys<R>>> }
    : O["sort"] extends ReadonlyArray<string> ? { readonly sort: Schema.optionalKey<Sort<O["sort"][number]>> }
    : {})
  & (O["page"] extends Schema.Struct.Fields ? { readonly page: Schema.optionalKey<Schema.Struct<O["page"]>> }
    : {})
  & (O["filter"] extends Schema.Struct.Fields ? { readonly filter: Schema.optionalKey<Schema.Struct<O["filter"]>> }
    : {})
>

/**
 * The flat (wire) struct fields of a query schema: every parameter is a
 * bracket-keyed string.
 */
export type FlatFields<R extends Any, O extends Options<R>> = Types.Simplify<
  & ([O["include"]] extends [true] ? { readonly include: Schema.optionalKey<Schema.String> } : {})
  & ([O["fields"]] extends [true] ? {
      readonly [TypeName in FieldsetResources<R>["type"] as `fields[${TypeName}]`]: Schema.optionalKey<Schema.String>
    }
    : {})
  & (O["sort"] extends true | ReadonlyArray<string> ? { readonly sort: Schema.optionalKey<Schema.String> } : {})
  & (O["page"] extends Schema.Struct.Fields ? {
      readonly [K in keyof O["page"] & string as `page[${K}]`]: Schema.optionalKey<Schema.String>
    }
    : {})
  & (O["filter"] extends Schema.Struct.Fields ? {
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
 */
export interface QuerySchema<R extends Any, O extends Options<R>> extends
  Schema.decodeTo<
    Schema.Struct<AsFields<NestedFields<R, O>>>,
    Schema.Struct<AsFields<FlatFields<R, O>>>,
    never,
    never
  >
{}

/**
 * Builds the query schema for a resource (or, for heterogeneous endpoints,
 * several resources) and a feature set.
 *
 * The result is passed as an `HttpApiEndpoint` `query` schema; handlers
 * receive the decoded nested shape, clients provide it and it is encoded back
 * to flat query parameters.
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
    const sortable = options.sort === true
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
