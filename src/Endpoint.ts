/**
 * JSON:API endpoint constructors.
 *
 * Thin, convention-baking constructors over `HttpApiEndpoint`, one per
 * JSON:API operation:
 *
 * | Constructor          | Method & path                              | Payload                  | Success                    |
 * | -------------------- | ------------------------------------------ | ------------------------ | -------------------------- |
 * | `fetch`              | `GET /<type>/:id`                          | —                        | 200, single-resource doc   |
 * | `list`               | `GET /<type>`                              | —                        | 200, collection doc        |
 * | `create`             | `POST /<type>`                             | `createPayload` (lid ok) | 201, single-resource doc   |
 * | `update`             | `PATCH /<type>/:id`                        | `updatePayload`          | 200, single-resource doc   |
 * | `remove`             | `DELETE /<type>/:id`                       | —                        | 204, no content            |
 * | `search`             | `GET /search`                              | —                        | 200, heterogeneous doc     |
 * | `related`            | `GET /<type>/:id/<name>`                   | —                        | 200, related resource(s)   |
 * | `fetchRelationship`  | `GET /<type>/:id/relationships/<name>`     | —                        | 200, linkage doc           |
 * | `updateRelationship` | `PATCH /<type>/:id/relationships/<name>`   | linkage                  | 200, linkage doc           |
 * | `addRelationship`    | `POST /<type>/:id/relationships/<name>`    | linkage (to-many only)   | 200, linkage doc           |
 * | `removeRelationship` | `DELETE /<type>/:id/relationships/<name>`  | linkage (to-many only)   | 204, no content            |
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
 *
 * @since 0.1.0
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi"
import * as Atomic from "./Atomic.js"
import { AnyMeta, CollectionDocument, DataDocument, LinkageDocument } from "./Document.js"
import { asJsonApi, asJsonApiAtomic } from "./internal/media.js"
import { ContentNegotiation, SchemaErrors } from "./Middleware.js"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import type {
  Any,
  AttributeKeys,
  DefaultIncluded,
  Relationships,
  Resource,
  Target,
  TargetsOf,
  ToManyName
} from "./Resource.js"
import { directTargets } from "./Resource.js"

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * The constraint satisfied by every `ApiError.make` class: something with a
 * derived wire schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface ErrorClass {
  readonly wire: Schema.Top
  readonly status: number
}

/**
 * The wire schemas of a tuple of error classes.
 *
 * @since 0.1.0
 * @category type-level
 */
export type Wires<Errors extends ReadonlyArray<ErrorClass>> = {
  readonly [K in keyof Errors]: Errors[K]["wire"]
}

const wires = <const Errors extends ReadonlyArray<ErrorClass>>(errors: Errors | undefined): Wires<Errors> =>
  ((errors ?? []) as Errors).map((error) => error.wire) as Wires<Errors>

// ---------------------------------------------------------------------------
// Shared option types
// ---------------------------------------------------------------------------

/**
 * Options common to all endpoint constructors.
 *
 * @since 0.1.0
 * @category models
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
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // GET /articles/:id?include=author&fields[articles]=title
 *   JsonApi.Endpoint.fetch(Article, {
 *     include: true,
 *     fields: true,
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
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
  HttpApiEndpoint.get((options?.name ?? "fetch") as Name, (options?.path ?? `/${resource.type}/:id`) as Path, {
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
  })
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
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // GET /articles?sort=-createdAt&page[offset]=0&page[limit]=10&filter[author]=9
 *   JsonApi.Endpoint.list(Article, {
 *     include: true,
 *     sort: ["createdAt", "title"],
 *     page: JsonApi.Page.Offset,
 *     filter: { author: Schema.optionalKey(Schema.String) }
 *   })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
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
  HttpApiEndpoint.get((options?.name ?? "list") as Name, (options?.path ?? `/${resource.type}`) as Path, {
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
  })
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
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // POST /articles → 201
 *   JsonApi.Endpoint.create(Article, { errors: [TitleTaken] })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
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
  HttpApiEndpoint.post((options?.name ?? "create") as Name, (options?.path ?? `/${resource.type}`) as Path, {
    payload: asJsonApi(resource.createPayload),
    success: asJsonApi(
      resource.document((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta }),
      201
    ),
    error: wires(options?.errors)
  })
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
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // PATCH /articles/:id (partial attributes)
 *   JsonApi.Endpoint.update(Article, { errors: [ArticleNotFound] })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
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
  HttpApiEndpoint.patch((options?.name ?? "update") as Name, (options?.path ?? `/${resource.type}/:id`) as Path, {
    params: { id: resource.Id },
    payload: asJsonApi(resource.updatePayload),
    success: asJsonApi(
      resource.document((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta })
    ),
    error: wires(options?.errors)
  })
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
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // DELETE /articles/:id → 204
 *   JsonApi.Endpoint.remove(Article, { errors: [ArticleNotFound] })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
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
  HttpApiEndpoint.delete((options?.name ?? "remove") as Name, (options?.path ?? `/${resource.type}/:id`) as Path, {
    params: { id: resource.Id },
    success: HttpApiSchema.NoContent,
    error: wires(options?.errors)
  })
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
 *
 * @since 0.1.0
 * @category models
 */
export interface SearchIncluded<Resources extends ReadonlyArray<Any>> extends Schema.Union<
  ReadonlyArray<TargetsOf<Resources[number]>>
> {}

/**
 * `GET /search` (path configurable) — a heterogeneous collection endpoint:
 * `data` is a mixed array of several resource types, discriminated by their
 * `type` tags. The natural fit for search results, feeds and timelines.
 *
 * Success is a 200 collection document whose `data` member is the union of
 * the given resources and whose `included` union spans all of their
 * relationship targets.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const search = JsonApi.Group(
 *   "search",
 *   // GET /search?filter[q]=bikeshed&include=author&page[offset]=0&page[limit]=10
 *   JsonApi.Endpoint.search([Article, Person], {
 *     filter: { q: Schema.String },
 *     include: true,
 *     fields: true,
 *     page: JsonApi.Page.Offset
 *   })
 * )
 * // handler returns { data: ReadonlyArray<Article | Person>, ... }
 * // query.include spans both resources' relationship graphs
 * // ?fields[articles]= and ?fields[people]= are both available
 * ```
 *
 * @since 0.1.0
 * @category constructors
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
  HttpApiEndpoint.get((options?.name ?? "search") as Name, (options?.path ?? "/search") as Path, {
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
  })
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// Relationship endpoints — shared type machinery
// ---------------------------------------------------------------------------

// Resolves to `T` for every concrete relationship; needed because conditional
// types over a still-generic resource can't be proven to satisfy `Schema.Top`.
type AsSchema<T> = T extends Schema.Top ? T : never

/**
 * The descriptor of a named relationship.
 */
type DescriptorOf<R extends Any, Name extends string> = R["relationships"][Name & keyof R["relationships"]]

/**
 * The linkage (`data`) schema of a relationship, by kind:
 *
 *   - `one` → the target's identifier (never null)
 *   - `optional` → the target's identifier or null
 *   - `many` / `paginated` → an array of the target's identifiers
 *
 * @since 0.1.0
 * @category type-level
 */
export type LinkageData<R extends Any, Name extends string> =
  DescriptorOf<R, Name> extends Relationship.One<infer T extends Any>
    ? T["identifier"]
    : DescriptorOf<R, Name> extends Relationship.Optional<infer T extends Any>
      ? Schema.NullOr<AsSchema<T["identifier"]>>
      : DescriptorOf<R, Name> extends Relationship.ToMany<infer T extends Any>
        ? Schema.$Array<AsSchema<T["identifier"]>>
        : never

/**
 * The success document schema of a relationship endpoint: a linkage document
 * whose `data` member matches the relationship's kind.
 *
 * @since 0.1.0
 * @category type-level
 */
export type RelationshipSuccess<R extends Any, Name extends string, DocMeta extends Schema.Top> = LinkageDocument<
  AsSchema<LinkageData<R, Name>>,
  DocMeta
>

/**
 * The request payload schema of a relationship mutation: `{ data: linkage }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface LinkagePayload<R extends Any, Name extends string> extends Schema.Struct<{
  readonly data: AsSchema<LinkageData<R, Name>>
}> {}

/**
 * The success document schema of a related-resource endpoint:
 *
 *   - to-one relationships → a single-resource document of the target
 *     (`data` may be null for `optional` relationships)
 *   - to-many relationships → a collection document of the target
 *
 * @since 0.1.0
 * @category type-level
 */
export type RelatedSuccess<R extends Any, Name extends string, DocMeta extends Schema.Top> =
  DescriptorOf<R, Name> extends Relationship.ToOne<infer T extends Any>
    ? DataDocument<T, DefaultIncluded<T["relationships"]>, DocMeta>
    : DescriptorOf<R, Name> extends Relationship.ToMany<infer T extends Any>
      ? CollectionDocument<T, DefaultIncluded<T["relationships"]>, DocMeta>
      : never

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

// Looks up a relationship descriptor by name; an unknown name is a programmer
// error (it is also a compile error at the constructor's call site).
const descriptorFor = (resource: Any, name: string): Relationship.Descriptor => {
  const descriptor = (resource.relationships as Record<string, Relationship.Descriptor>)[name]
  if (descriptor === undefined) {
    throw new Error(`Unknown relationship "${name}" on resource "${resource.type}"`)
  }
  return descriptor
}

// The runtime linkage (`data`) schema for a relationship descriptor.
const linkageData = (descriptor: Relationship.Descriptor, target: Any): Schema.Top =>
  descriptor.kind === "one"
    ? target.identifier
    : descriptor.kind === "optional"
      ? Schema.NullOr(target.identifier)
      : Schema.Array(target.identifier)

// ---------------------------------------------------------------------------
// related — GET /<type>/:id/<name>
// ---------------------------------------------------------------------------

/**
 * `GET /<type>/:id/<name>` — fetch the resource(s) a relationship points at.
 *
 * This is the endpoint a relationship's `related` link refers to. For to-one
 * relationships success is a single-resource document of the target; for
 * to-many relationships it is a collection document, with the full set of
 * collection query parameters (`include`, `fields`, `sort`, `page`, `filter`)
 * available.
 *
 * For `paginated` relationships this *is* the collection their required
 * `links.related` member points at — enable `page` here.
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // GET /articles/:id/author — the author, as a full resource
 *   JsonApi.Endpoint.related(Article, "author", { errors: [ArticleNotFound] }),
 *   // GET /articles/:id/comments?page[offset]=0&page[limit]=10&include=author
 *   JsonApi.Endpoint.related(Article, "comments", {
 *     include: true,
 *     page: JsonApi.Page.Offset,
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const related = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Name extends keyof Rels & string,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = Name,
  const Path extends `/${string}` = `/${Type}/:id/${Name}`,
  const Include extends boolean = false,
  const Fields extends boolean = false,
  const Sort extends boolean | ReadonlyArray<AttributeKeys<Target<Resource<Type, Attributes, Rels, Meta>, Name>>> =
    false,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  const FilterFields extends Schema.Struct.Fields | undefined = undefined,
  DocMeta extends Schema.Top = typeof AnyMeta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors> & {
    /** Enable the `?include=` query parameter (paths span the *target's* graph). */
    readonly include?: Include
    /** Enable `?fields[TYPE]=` sparse fieldsets for the target and its targets. */
    readonly fields?: Fields
    /** Enable `?sort=` over the target's attributes (to-many relationships). */
    readonly sort?: Sort
    /** Enable `?page[*]=` pagination (to-many relationships; see `Query.Page`). */
    readonly page?: PageFields
    /** Enable `?filter[*]=` filtering (user-defined fields). */
    readonly filter?: FilterFields
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta
  }
) => {
  type R = Resource<Type, Attributes, Rels, Meta>
  const descriptor = descriptorFor(resource, name)
  const target = descriptor.ref()
  const included = Schema.Union(directTargets(target))
  const docMeta = (options?.meta ?? AnyMeta) as DocMeta
  // The cast is sound: the runtime schema mirrors `RelatedSuccess` exactly —
  // a data document for to-one descriptors, a collection document otherwise.
  const success = (Relationship.isToOne(descriptor)
    ? DataDocument(target, { included, meta: docMeta })
    : CollectionDocument(target, { included, meta: docMeta })) as unknown as AsSchema<RelatedSuccess<R, Name, DocMeta>>

  return HttpApiEndpoint.get(
    (options?.name ?? name) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/${name}`) as Path,
    {
      params: { id: resource.Id },
      query: Query.schema(
        target as Target<R, Name>,
        queryConfig(options) as {
          readonly include: Include
          readonly fields: Fields
          readonly sort: Sort
          readonly page: PageFields
          readonly filter: FilterFields
        }
      ),
      success: asJsonApi(success),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)
}

// ---------------------------------------------------------------------------
// fetchRelationship — GET /<type>/:id/relationships/<name>
// ---------------------------------------------------------------------------

/**
 * `GET /<type>/:id/relationships/<name>` — fetch a relationship's linkage.
 *
 * Success is a 200 linkage document: `data` is a single identifier (`one`),
 * an identifier or null (`optional`), or an identifier array (`many` /
 * `paginated`) — never full resource objects.
 *
 * For `paginated` relationships the identifier collection itself can be
 * paginated — enable `page`.
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // GET /articles/:id/relationships/comments?page[offset]=0&page[limit]=10
 *   JsonApi.Endpoint.fetchRelationship(Article, "comments", {
 *     page: JsonApi.Page.Offset,
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-relationships}
 * @since 0.1.0
 * @category constructors
 */
export const fetchRelationship = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Name extends keyof Rels & string,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = `${Name}Relationship`,
  const Path extends `/${string}` = `/${Type}/:id/relationships/${Name}`,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  DocMeta extends Schema.Top = typeof AnyMeta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors> & {
    /** Enable `?page[*]=` pagination of the identifier collection (to-many linkage). */
    readonly page?: PageFields
    /** Override the linkage document's `meta` schema. */
    readonly meta?: DocMeta
  }
) => {
  type R = Resource<Type, Attributes, Rels, Meta>
  const descriptor = descriptorFor(resource, name)
  const target = descriptor.ref()
  // The cast is sound: `linkageData` mirrors `LinkageData` kind by kind.
  const success = LinkageDocument(linkageData(descriptor, target), {
    meta: (options?.meta ?? AnyMeta) as DocMeta
  }) as unknown as RelationshipSuccess<R, Name, DocMeta>

  return HttpApiEndpoint.get(
    (options?.name ?? `${name}Relationship`) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/relationships/${name}`) as Path,
    {
      params: { id: resource.Id },
      query: Query.schema(
        target as Target<R, Name>,
        {
          include: false,
          fields: false,
          sort: false,
          page: options?.page,
          filter: undefined
        } as {
          readonly include: false
          readonly fields: false
          readonly sort: false
          readonly page: PageFields
          readonly filter: undefined
        }
      ),
      success: asJsonApi(success),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)
}

// ---------------------------------------------------------------------------
// updateRelationship — PATCH /<type>/:id/relationships/<name>
// ---------------------------------------------------------------------------

/**
 * `PATCH /<type>/:id/relationships/<name>` — replace a relationship's linkage.
 *
 * The payload is the full replacement linkage:
 *
 *   - `one` → `{ data: identifier }` (a required relationship can't be cleared)
 *   - `optional` → `{ data: identifier | null }`
 *   - `many` / `paginated` → `{ data: identifier[] }` (full replacement)
 *
 * Success is a 200 linkage document with the updated linkage.
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // PATCH /articles/:id/relationships/author — replace the author
 *   JsonApi.Endpoint.updateRelationship(Article, "author", {
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-updating-relationships}
 * @since 0.1.0
 * @category constructors
 */
export const updateRelationship = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Name extends keyof Rels & string,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = `update${Capitalize<Name>}Relationship`,
  const Path extends `/${string}` = `/${Type}/:id/relationships/${Name}`,
  DocMeta extends Schema.Top = typeof AnyMeta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors> & {
    /** Override the linkage document's `meta` schema. */
    readonly meta?: DocMeta
  }
) => {
  type R = Resource<Type, Attributes, Rels, Meta>
  const descriptor = descriptorFor(resource, name)
  const target = descriptor.ref()
  const data = linkageData(descriptor, target)
  // The casts are sound: the runtime schemas mirror the conditional types kind by kind.
  const payload = Schema.Struct({ data }) as unknown as LinkagePayload<R, Name>
  const success = LinkageDocument(data, {
    meta: (options?.meta ?? AnyMeta) as DocMeta
  }) as unknown as RelationshipSuccess<R, Name, DocMeta>

  return HttpApiEndpoint.patch(
    (options?.name ?? `update${capitalize(name)}Relationship`) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/relationships/${name}`) as Path,
    {
      params: { id: resource.Id },
      payload: asJsonApi(payload),
      success: asJsonApi(success),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)
}

// ---------------------------------------------------------------------------
// addRelationship — POST /<type>/:id/relationships/<name> (to-many only)
// ---------------------------------------------------------------------------

/**
 * `POST /<type>/:id/relationships/<name>` — add members to a to-many
 * relationship.
 *
 * Only `many` / `paginated` relationships have this endpoint (the spec defines
 * POST only for to-many relationship URLs). The payload is the identifiers to
 * add; members already present are ignored. Success is a 200 linkage document
 * with the resulting linkage.
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // POST /articles/:id/relationships/comments — attach existing comments
 *   JsonApi.Endpoint.addRelationship(Article, "comments", {
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-updating-to-many-relationships}
 * @since 0.1.0
 * @category constructors
 */
export const addRelationship = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Name extends ToManyName<Resource<Type, Attributes, Rels, Meta>>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = `add${Capitalize<Name>}Relationship`,
  const Path extends `/${string}` = `/${Type}/:id/relationships/${Name}`,
  DocMeta extends Schema.Top = typeof AnyMeta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors> & {
    /** Override the linkage document's `meta` schema. */
    readonly meta?: DocMeta
  }
) => {
  type R = Resource<Type, Attributes, Rels, Meta>
  const descriptor = descriptorFor(resource, name)
  const target = descriptor.ref()
  const data = Schema.Array(target.identifier)
  // The casts are sound: to-many linkage is always an identifier array.
  const payload = Schema.Struct({ data }) as unknown as LinkagePayload<R, Name>
  const success = LinkageDocument(data, {
    meta: (options?.meta ?? AnyMeta) as DocMeta
  }) as unknown as RelationshipSuccess<R, Name, DocMeta>

  return HttpApiEndpoint.post(
    (options?.name ?? `add${capitalize(name)}Relationship`) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/relationships/${name}`) as Path,
    {
      params: { id: resource.Id },
      payload: asJsonApi(payload),
      success: asJsonApi(success),
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)
}

// ---------------------------------------------------------------------------
// removeRelationship — DELETE /<type>/:id/relationships/<name> (to-many only)
// ---------------------------------------------------------------------------

/**
 * `DELETE /<type>/:id/relationships/<name>` — remove members from a to-many
 * relationship.
 *
 * Only `many` / `paginated` relationships have this endpoint. The payload is
 * the identifiers to remove; members not present are ignored. Success is a
 * 204 No Content response.
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const articles = JsonApi.Group(
 *   Article,
 *   // DELETE /articles/:id/relationships/comments → 204 — detach comments
 *   JsonApi.Endpoint.removeRelationship(Article, "comments", {
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-updating-to-many-relationships}
 * @since 0.1.0
 * @category constructors
 */
export const removeRelationship = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Name extends ToManyName<Resource<Type, Attributes, Rels, Meta>>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = `remove${Capitalize<Name>}Relationship`,
  const Path extends `/${string}` = `/${Type}/:id/relationships/${Name}`
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors>
) => {
  type R = Resource<Type, Attributes, Rels, Meta>
  const descriptor = descriptorFor(resource, name)
  const target = descriptor.ref()
  // The cast is sound: to-many linkage is always an identifier array.
  const payload = Schema.Struct({
    data: Schema.Array(target.identifier)
  }) as unknown as LinkagePayload<R, Name>

  return HttpApiEndpoint.delete(
    (options?.name ?? `remove${capitalize(name)}Relationship`) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/relationships/${name}`) as Path,
    {
      params: { id: resource.Id },
      payload: asJsonApi(payload),
      success: HttpApiSchema.NoContent,
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)
}

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
 *
 * @example
 * ```ts
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const operations = JsonApi.Group(
 *   "operations",
 *   // POST /operations with an atomic:operations document
 *   JsonApi.Endpoint.operations([Article, Comment], {
 *     errors: [OperationFailed]
 *   })
 * )
 * // payload:  { "atomic:operations": [{ op: "add", data: {...} }, ...] }
 * // success:  { "atomic:results": [{ data: {...} }, ...] }   (200)
 * ```
 *
 * @since 0.1.0
 * @category constructors
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
  HttpApiEndpoint.post((options?.name ?? "operations") as Name, (options?.path ?? "/operations") as Path, {
    payload: asJsonApi(Atomic.RequestDocument(resources)),
    success: asJsonApiAtomic(
      Atomic.ResultDocument(
        resources,
        (options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta }
      )
    ),
    error: wires(options?.errors)
  })
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)
