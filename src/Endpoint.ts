/**
 * JSON:API endpoint constructors.
 *
 * Thin, convention-baking constructors over `HttpApiEndpoint`, one per
 * JSON:API operation:
 *
 * | Constructor | Method & path            | Payload                  | Success                    |
 * | ----------- | ------------------------ | ------------------------ | -------------------------- |
 * | `fetch`      | `GET /<type>/:id`        | —                        | 200, single-resource doc   |
 * | `list`       | `GET /<type>`            | —                        | 200, collection doc        |
 * | `create`     | `POST /<type>`           | `createPayload` (lid ok) | 201, single-resource doc   |
 * | `update`     | `PATCH /<type>/:id`      | `updatePayload`          | 200, single-resource doc   |
 * | `remove`     | `DELETE /<type>/:id`     | —                        | 204, no content            |
 * | `search`     | `GET /search`            | —                        | 200, heterogeneous doc     |
 * | `operations` | `POST /operations`       | `atomic:operations` doc  | 200, `atomic:results` doc  |
 *
 * Every endpoint automatically:
 *   - serves and accepts `application/vnd.api+json`
 *   - carries the {@link Middleware} content-negotiation and schema-error
 *     middlewares, so 400/406/415 are spec-compliant JSON:API error documents
 *     and the api cannot be built without providing them
 *   - declares its errors as JSON:API error documents (pass `ApiError`
 *     classes via `errors`)
 *   - exposes typed query parameters (`include`, `fields`, `sort`, `page`,
 *     `filter`) when enabled
 *
 * Names and paths follow the conventions above but can be overridden.
 *
 * The constructors return plain `HttpApiEndpoint` values: everything composes
 * with vanilla `HttpApiGroup` / `HttpApi` / `HttpApiBuilder` / `HttpApiClient`
 * / `HttpApiTest` / `OpenApi`.
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi"
import * as Atomic from "./Atomic.js"
import { AnyMeta, CollectionDocument } from "./Document.js"
import { asJsonApi, asJsonApiAtomic } from "./internal/media.js"
import { ContentNegotiation, SchemaErrors } from "./Middleware.js"
import * as Query from "./Query.js"
import type { Any, AttributeKeys, Relationships, Resource, TargetsOf } from "./Resource.js"
import { directTargets } from "./Resource.js"

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * The constraint satisfied by every `ApiError.make` class: something with a
 * derived wire schema.
 */
export interface ErrorClass {
  readonly wire: Schema.Top
  readonly status: number
}

/**
 * The wire schemas of a tuple of error classes.
 */
export type Wires<Errors extends ReadonlyArray<ErrorClass>> = {
  readonly [K in keyof Errors]: Errors[K]["wire"]
}

const wires = <const Errors extends ReadonlyArray<ErrorClass>>(
  errors: Errors | undefined
): Wires<Errors> => ((errors ?? []) as Errors).map((error) => error.wire) as Wires<Errors>

// ---------------------------------------------------------------------------
// Shared option types
// ---------------------------------------------------------------------------

/**
 * Options common to all endpoint constructors.
 */
export interface CommonOptions<Name extends string, Path extends `/${string}`, Errors> {
  /** Endpoint name within its group. Defaults to the operation name (`"fetch"`, `"list"`, …). */
  readonly name?: Name
  /** Route path. Defaults to the conventional JSON:API path for the operation. */
  readonly path?: Path
  /** `ApiError` classes this endpoint can fail with. */
  readonly errors?: Errors
}

const queryConfig = (options?: {
  readonly include?: boolean
  readonly fields?: boolean
  readonly sort?: boolean | ReadonlyArray<string>
  readonly page?: Schema.Struct.Fields
  readonly filter?: Schema.Struct.Fields
}) => ({
  include: options?.include === true,
  fields: options?.fields === true,
  sort: options?.sort ?? false,
  page: options?.page,
  filter: options?.filter
})

// ---------------------------------------------------------------------------
// fetch — GET /<type>/:id
// ---------------------------------------------------------------------------

/**
 * `GET /<type>/:id` — fetch a single resource.
 *
 * Success is a 200 single-resource document (`data` may be `null`); the
 * compound `included` union is derived from the resource's relationships.
 */
export const fetch = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "fetch",
  const Path extends `/${string}` = `/${Type}/:id`,
  const Include extends boolean = false,
  const Fields extends boolean = false,
  DocMeta extends Schema.Top = Meta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Enable the `?include=` query parameter. */
    readonly include?: Include
    /** Enable `?fields[TYPE]=` sparse fieldsets. */
    readonly fields?: Fields
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta
  }
) =>
  HttpApiEndpoint.get(
    (options?.name ?? "fetch") as Name,
    (options?.path ?? `/${resource.type}/:id`) as Path,
    {
      params: { id: resource.Id },
      query: Query.schema(
        resource,
        queryConfig(options) as {
          readonly include: Include
          readonly fields: Fields
          readonly sort: false
          readonly page: undefined
          readonly filter: undefined
        }
      ),
      success: asJsonApi(
        resource.document((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta })
      ),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// list — GET /<type>
// ---------------------------------------------------------------------------

/**
 * `GET /<type>` — list a collection of resources.
 *
 * Success is a 200 collection document (strict array `data`). Enable `sort`,
 * `page` and `filter` for the spec's collection query parameters.
 */
export const list = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "list",
  const Path extends `/${string}` = `/${Type}`,
  const Include extends boolean = false,
  const Fields extends boolean = false,
  const Sort extends boolean | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta>>> = false,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  const FilterFields extends Schema.Struct.Fields | undefined = undefined,
  DocMeta extends Schema.Top = Meta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Enable the `?include=` query parameter. */
    readonly include?: Include
    /** Enable `?fields[TYPE]=` sparse fieldsets. */
    readonly fields?: Fields
    /** Enable `?sort=`: `true` for all attributes, or an array of sortable attribute names. */
    readonly sort?: Sort
    /** Enable `?page[*]=` pagination (see `Query.Page` for ready-made strategies). */
    readonly page?: PageFields
    /** Enable `?filter[*]=` filtering (user-defined fields). */
    readonly filter?: FilterFields
    /** Override the collection document's `meta` schema (e.g. pagination totals). */
    readonly meta?: DocMeta
  }
) =>
  HttpApiEndpoint.get(
    (options?.name ?? "list") as Name,
    (options?.path ?? `/${resource.type}`) as Path,
    {
      query: Query.schema(
        resource,
        queryConfig(options) as {
          readonly include: Include
          readonly fields: Fields
          readonly sort: Sort
          readonly page: PageFields
          readonly filter: FilterFields
        }
      ),
      success: asJsonApi(
        resource.collection((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta })
      ),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// create — POST /<type>
// ---------------------------------------------------------------------------

/**
 * `POST /<type>` — create a resource.
 *
 * The request payload is the resource's `createPayload` (no `id`, client may
 * send a `lid`); success is a 201 single-resource document containing the
 * created resource.
 */
export const create = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "create",
  const Path extends `/${string}` = `/${Type}`,
  DocMeta extends Schema.Top = Meta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta
  }
) =>
  HttpApiEndpoint.post(
    (options?.name ?? "create") as Name,
    (options?.path ?? `/${resource.type}`) as Path,
    {
      payload: asJsonApi(resource.createPayload),
      success: asJsonApi(
        resource.document((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta }),
        201
      ),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// update — PATCH /<type>/:id
// ---------------------------------------------------------------------------

/**
 * `PATCH /<type>/:id` — update a resource.
 *
 * The request payload is the resource's `updatePayload` (`id` required,
 * attributes partial); success is a 200 single-resource document containing
 * the updated resource.
 */
export const update = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "update",
  const Path extends `/${string}` = `/${Type}/:id`,
  DocMeta extends Schema.Top = Meta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta
  }
) =>
  HttpApiEndpoint.patch(
    (options?.name ?? "update") as Name,
    (options?.path ?? `/${resource.type}/:id`) as Path,
    {
      params: { id: resource.Id },
      payload: asJsonApi(resource.updatePayload),
      success: asJsonApi(
        resource.document((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta })
      ),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// remove — DELETE /<type>/:id
// ---------------------------------------------------------------------------

/**
 * `DELETE /<type>/:id` — delete a resource.
 *
 * Success is a 204 No Content response, per the spec's recommendation for
 * deletions with no additional information to return.
 */
export const remove = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "remove",
  const Path extends `/${string}` = `/${Type}/:id`
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: CommonOptions<Name, Path, Errors>
) =>
  HttpApiEndpoint.delete(
    (options?.name ?? "remove") as Name,
    (options?.path ?? `/${resource.type}/:id`) as Path,
    {
      params: { id: resource.Id },
      success: HttpApiSchema.NoContent,
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// search — GET <path>, heterogeneous collection
// ---------------------------------------------------------------------------

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)]

/**
 * The default compound `included` union of a heterogeneous endpoint: every
 * resource directly referenced by any of the searched resources'
 * relationships.
 */
export interface SearchIncluded<Resources extends ReadonlyArray<Any>> extends
  Schema.Union<ReadonlyArray<TargetsOf<Resources[number]>>>
{}

/**
 * `GET /search` (path configurable) — a heterogeneous collection endpoint:
 * `data` is a mixed array of several resource types, discriminated by their
 * `type` tags. The natural fit for search results, feeds and timelines.
 *
 * ```ts
 * const search = Endpoint.search([Article, Person], {
 *   filter: { q: Schema.String },
 *   page: Query.Page.Offset,
 *   include: true
 * })
 * // handler returns { data: ReadonlyArray<Article | Person>, ... }
 * // query.include spans both resources' relationship graphs
 * // ?fields[articles]= and ?fields[people]= are both available
 * ```
 *
 * Success is a 200 collection document whose `data` member is the union of
 * the given resources and whose `included` union spans all of their
 * relationship targets.
 */
export const search = <
  const Resources extends ReadonlyArray<Any>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "search",
  const Path extends `/${string}` = "/search",
  const Include extends boolean = false,
  const Fields extends boolean = false,
  const Sort extends boolean | ReadonlyArray<AttributeKeys<Resources[number]>> = false,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  const FilterFields extends Schema.Struct.Fields | undefined = undefined,
  DocMeta extends Schema.Top = typeof AnyMeta
>(
  resources: Resources,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Enable the `?include=` query parameter (paths span all resources' graphs). */
    readonly include?: Include
    /** Enable `?fields[TYPE]=` sparse fieldsets for all resources and their targets. */
    readonly fields?: Fields
    /** Enable `?sort=`: `true` for every attribute of every resource, or an explicit list. */
    readonly sort?: Sort
    /** Enable `?page[*]=` pagination (see `Query.Page` for ready-made strategies). */
    readonly page?: PageFields
    /** Enable `?filter[*]=` filtering (user-defined fields, e.g. the search term). */
    readonly filter?: FilterFields
    /** Override the collection document's `meta` schema (e.g. result totals). */
    readonly meta?: DocMeta
  }
) =>
  HttpApiEndpoint.get(
    (options?.name ?? "search") as Name,
    (options?.path ?? "/search") as Path,
    {
      query: Query.schema(
        resources as ReadonlyArray<Resources[number]>,
        queryConfig(options) as {
          readonly include: Include
          readonly fields: Fields
          readonly sort: Sort
          readonly page: PageFields
          readonly filter: FilterFields
        }
      ),
      success: asJsonApi(
        CollectionDocument(Schema.Union(resources), {
          // The cast is sound: every direct target of every member of
          // `Resources` is, by construction, a member of `TargetsOf<...>`.
          included: Schema.Union(
            dedupe(resources.flatMap((resource) => directTargets(resource)))
          ) as unknown as SearchIncluded<Resources>,
          meta: (options?.meta ?? AnyMeta) as DocMeta
        })
      ),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// operations — POST /operations, atomic operations extension
// ---------------------------------------------------------------------------

/**
 * `POST /operations` (path configurable) — the
 * {@link https://jsonapi.org/ext/atomic/ atomic operations extension}: a
 * single request carrying an ordered list of operations — creating, updating
 * and deleting resources or their relationships — that the handler processes
 * atomically.
 *
 * ```ts
 * const operations = Endpoint.operations([Article, Comment], {
 *   errors: [OperationFailed]
 * })
 * // payload:  { "atomic:operations": [{ op: "add", data: {...} }, ...] }
 * // success:  { "atomic:results": [{ data: {...} }, ...] }   (200)
 * ```
 *
 * The request payload is an `atomic:operations` document whose operation union
 * spans every operation legal for the given resources (including relationship
 * operations and lid-based refs); success is a 200 `atomic:results` document
 * whose entries correspond to the operations, in order.
 *
 * Spec-compliant clients send the JSON:API media type with the
 * `ext="https://jsonapi.org/ext/atomic"` parameter — provide the
 * content-negotiation middleware via
 * `Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })` so those
 * requests are accepted.
 */
export const operations = <
  const Resources extends ReadonlyArray<Any>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "operations",
  const Path extends `/${string}` = "/operations",
  DocMeta extends Schema.Top = typeof AnyMeta
>(
  resources: Resources,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Override the result document's `meta` schema. */
    readonly meta?: DocMeta
  }
) =>
  HttpApiEndpoint.post(
    (options?.name ?? "operations") as Name,
    (options?.path ?? "/operations") as Path,
    {
      payload: asJsonApi(Atomic.RequestDocument(resources)),
      success: asJsonApiAtomic(
        Atomic.ResultDocument(
          resources,
          (options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta }
        )
      ),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)
