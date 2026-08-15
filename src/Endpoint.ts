/**
 * JSON:API endpoint constructors.
 *
 * Thin, convention-baking constructors over `HttpApiEndpoint`, one per
 * JSON:API operation:
 *
 * | Constructor          | Method & path                              | Payload                  | Success                    |
 * | -------------------- | ------------------------------------------ | ------------------------ | -------------------------- |
 * | `get`                | `GET /<type>/:id`                          | —                        | 200, single-resource doc   |
 * | `list`               | `GET /<type>`                              | —                        | 200, collection doc        |
 * | `create`             | `POST /<type>`                             | `createPayload` (lid ok) | 201, single-resource doc   |
 * | `update`             | `PATCH /<type>/:id`                        | `updatePayload`          | 200, single-resource doc   |
 * | `delete`             | `DELETE /<type>/:id`                       | —                        | 204, no content (`success`)|
 * | `collection`         | `GET <path>`                               | —                        | 200, heterogeneous doc     |
 * | `related`            | `GET /<type>/:id/<name>`                   | —                        | 200, related resource(s)   |
 * | `getRelationship`    | `GET /<type>/:id/relationships/<name>`     | —                        | 200, linkage doc           |
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
 * Names and paths follow the conventions above but can be overridden, as can
 * the write payloads: `create` / `update` default to the enveloped
 * `createPayload` / `updatePayload`, and take a `payload` option for apis whose
 * write contract is a flat command input (e.g. the resource's own
 * `createInput` / `updateInput`) rather than a JSON:API document. `delete`
 * likewise takes a `success` option for apis whose deletion answers with a
 * body — a soft delete returning the tombstone resource — instead of 204, and
 * `list` a `query` option replacing the composed query schema wholesale, for
 * apis whose list contract is a flat struct of their own.
 *
 * For the common case, {@link resource} derives an entire endpoint set — the
 * CRUD surface plus every relationship's endpoints, with query parameters
 * derived from the resource graph — from a single resource definition (and
 * `Group.resource` wraps it into a whole `HttpApiGroup`).
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
import type { Relationships } from "./Relationship.js"
import type {
  Any,
  AttributeKeys,
  DefaultIncluded,
  Family,
  RelationshipName,
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
  /** Endpoint name within its group. Defaults to the operation name (`"get"`, `"list"`, …). */
  readonly name?: Name
  /** Route path. Defaults to the conventional JSON:API path for the operation. */
  readonly path?: Path
  /** `ApiError` classes this endpoint can fail with. */
  readonly errors?: Errors
}

const queryConfig = (options?: {
  readonly include?: boolean | { readonly paths?: ReadonlyArray<string>; readonly depth?: number }
  readonly fields?: boolean
  readonly sort?: boolean | ReadonlyArray<string>
  readonly page?: Schema.Struct.Fields
  readonly filter?: Schema.Struct.Fields
}) => ({
  include: options?.include ?? false,
  fields: options?.fields === true,
  sort: options?.sort ?? false,
  page: options?.page,
  filter: options?.filter
})

// ---------------------------------------------------------------------------
// get — GET /<type>/:id
// ---------------------------------------------------------------------------

/**
 * `GET /<type>/:id` — fetch a single resource.
 *
 * Success is a 200 single-resource document whose primary `data` is the
 * resource itself (non-null — a missing resource is a `404`, not
 * `200 { data: null }`); the compound `included` union is derived from the
 * resource's relationships.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // GET /articles/:id?include=author&fields[articles]=title
 *   Endpoint.get(Article, {
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
export const get = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "get",
  const Path extends `/${string}` = `/${Type}/:id`,
  const Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta>> = false,
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
  HttpApiEndpoint.get((options?.name ?? "get") as Name, (options?.path ?? `/${resource.type}/:id`) as Path, {
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
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
    error: wires(options?.errors)
  })
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// list — GET /<type>
// ---------------------------------------------------------------------------

// The query schema `list` composes from its own feature options — the default
// its `query` option overrides.
type DefaultListQuery<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta>>,
  Fields extends boolean,
  Sort extends boolean | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta>>>,
  PageFields extends Schema.Struct.Fields | undefined,
  FilterFields extends Schema.Struct.Fields | undefined
> = Query.QuerySchema<
  Resource<Type, Attributes, Rels, Meta>,
  {
    readonly include: Include
    readonly fields: Fields
    readonly sort: Sort
    readonly page: PageFields
    readonly filter: FilterFields
  }
>

/**
 * `GET /<type>` — list a collection of resources.
 *
 * Success is a 200 collection document (strict array `data`). Enable `sort`,
 * `page` and `filter` for the spec's collection query parameters.
 *
 * Those options compose the whole query schema — a flat, bracket-keyed string
 * record on the wire that decodes to the spec's nested shape (`page: { offset,
 * limit }`, `filter: { … }`). Pass `query` to replace that composition with any
 * schema, for apis whose list contract is a flat struct their own operations
 * layer consumes, or that carry parameters JSON:API has no family for. Only
 * the query changes; the success document, path, errors and middleware are
 * unaffected.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Group, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     title: Schema.NonEmptyString,
 *     body: Schema.String,
 *     createdAt: Schema.DateFromString
 *   }
 * })
 *
 * const articles = Group.make(
 *   Article,
 *   // GET /articles?sort=-createdAt&page[offset]=0&page[limit]=10&filter[author]=9
 *   Endpoint.list(Article, {
 *     include: true,
 *     sort: ["createdAt", "title"],
 *     page: Query.Page.Offset,
 *     filter: { author: Schema.optionalKey(Schema.String) }
 *   })
 * )
 *
 * // …or with a query schema of your own: a flat struct, page cursor bracketed
 * // on the wire but decoded flat, alongside parameters JSON:API has no family for
 * const flatArticles = Group.make(
 *   Article,
 *   Endpoint.list(Article, {
 *     query: Query.bracketPageKeys(
 *       Schema.Struct({
 *         ...Query.Page.offset({ maxLimit: 100 }),
 *         authorId: Schema.optionalKey(Schema.String)
 *       })
 *     )
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
  const Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta>> = false,
  const Fields extends boolean = false,
  const Sort extends boolean | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta>>> = false,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  const FilterFields extends Schema.Struct.Fields | undefined = undefined,
  DocMeta extends Schema.Top = Meta,
  QuerySchema extends Schema.Top = DefaultListQuery<
    Type,
    Attributes,
    Rels,
    Meta,
    Include,
    Fields,
    Sort,
    PageFields,
    FilterFields
  >
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
    /**
     * Override the whole query schema. Defaults to the `Query.schema`
     * composition of the `include` / `fields` / `sort` / `page` / `filter`
     * options above (which those options are then ignored by); pass any schema
     * for a list contract of your own — e.g. a flat struct whose page cursor is
     * bracketed on the wire by `Query.bracketPageKeys` but decoded flat.
     */
    readonly query?: QuerySchema
  }
) =>
  HttpApiEndpoint.get((options?.name ?? "list") as Name, (options?.path ?? `/${resource.type}`) as Path, {
    query: (options?.query ??
      Query.schema(
        resource,
        queryConfig(options) as {
          readonly include: Include
          readonly fields: Fields
          readonly sort: Sort
          readonly page: PageFields
          readonly filter: FilterFields
        }
      )) as QuerySchema,
    success: asJsonApi(
      resource.collection((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta })
    ),
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
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
 * The request payload defaults to the resource's `createPayload` — the nested
 * JSON:API envelope (`{ data: { type, lid?, attributes, relationships } }`);
 * success is a 201 single-resource document containing the created resource.
 *
 * Pass `payload` to override that envelope with any schema — most usefully the
 * resource's own flat `createInput` projection, for a write contract that is a
 * flat command input rather than a JSON:API document. Only the request body
 * changes; the success document, path, errors and middleware are unaffected.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * class TitleTaken extends ApiError.make<TitleTaken>()("TitleTaken", {
 *   status: 409,
 *   fields: { title: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // POST /articles → 201, body { data: { type, attributes } }
 *   Endpoint.create(Article, { errors: [TitleTaken] })
 * )
 *
 * // …or with a flat command-input body: { title, body }
 * const flatArticles = Group.make(
 *   Article,
 *   Endpoint.create(Article, { payload: Article.createInput })
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
  DocMeta extends Schema.Top = Meta,
  Payload extends Schema.Top = Resource<Type, Attributes, Rels, Meta>["createPayload"]
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta
    /**
     * Override the request payload schema. Defaults to the resource's
     * `createPayload` (the JSON:API envelope); pass `resource.createInput` for
     * the flat command-input shape, or any schema of your own.
     */
    readonly payload?: Payload
  }
) =>
  HttpApiEndpoint.post((options?.name ?? "create") as Name, (options?.path ?? `/${resource.type}`) as Path, {
    payload: asJsonApi((options?.payload ?? resource.createPayload) as Payload),
    success: asJsonApi(
      resource.document((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta }),
      201
    ),
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
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
 * The request payload defaults to the resource's `updatePayload` — the nested
 * JSON:API envelope with `id` required and attributes partial; success is a
 * 200 single-resource document containing the updated resource.
 *
 * Pass `payload` to override that envelope with any schema — most usefully the
 * resource's own flat `updateInput` projection, for a write contract that is a
 * flat command input rather than a JSON:API document. Only the request body
 * changes; the `:id` path param, success document, errors and middleware are
 * unaffected.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // PATCH /articles/:id (partial attributes), body { data: { type, id, attributes } }
 *   Endpoint.update(Article, { errors: [ArticleNotFound] })
 * )
 *
 * // …or with a flat command-input body: { id, title?, body? }
 * const flatArticles = Group.make(
 *   Article,
 *   Endpoint.update(Article, { payload: Article.updateInput })
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
  DocMeta extends Schema.Top = Meta,
  Payload extends Schema.Top = Resource<Type, Attributes, Rels, Meta>["updatePayload"]
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta
    /**
     * Override the request payload schema. Defaults to the resource's
     * `updatePayload` (the JSON:API envelope); pass `resource.updateInput` for
     * the flat command-input shape, or any schema of your own.
     */
    readonly payload?: Payload
  }
) =>
  HttpApiEndpoint.patch((options?.name ?? "update") as Name, (options?.path ?? `/${resource.type}/:id`) as Path, {
    params: { id: resource.Id },
    payload: asJsonApi((options?.payload ?? resource.updatePayload) as Payload),
    success: asJsonApi(
      resource.document((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta })
    ),
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
    error: wires(options?.errors)
  })
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// delete — DELETE /<type>/:id
// ---------------------------------------------------------------------------

// The success response of a `delete` endpoint. Without an override it is the
// spec's 204 no-content default; an override is served as a JSON:API body,
// defaulting to 200 (the status HttpApi gives a success schema that carries
// one).
const deleteSuccess = (success: Schema.Top | undefined, status: number | undefined): Schema.Top =>
  success === undefined
    ? status === undefined
      ? HttpApiSchema.NoContent
      : HttpApiSchema.NoContent.pipe(HttpApiSchema.status(status))
    : asJsonApi(success, status)

/**
 * `DELETE /<type>/:id` — delete a resource.
 *
 * Success defaults to a 204 No Content response, per the spec's recommendation
 * for deletions with no additional information to return.
 *
 * Pass `success` to answer with a body instead — most usefully the resource's
 * own document, for apis whose delete is a soft delete that returns the
 * tombstone resource. The schema is served as `application/vnd.api+json` like
 * every other body in the package, at 200 unless `status` says otherwise. Only
 * the response changes; the `:id` path param, errors and middleware are
 * unaffected.
 *
 * Exported as `Endpoint.delete`. Because `delete` is a reserved word it cannot
 * be a bare `const` binding, so it is re-exported from the internal
 * `deleteEndpoint` implementation — `Endpoint.delete(...)` is the public name.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // DELETE /articles/:id → 204
 *   Endpoint.delete(Article, { errors: [ArticleNotFound] })
 * )
 *
 * // …or, for a soft delete answering with the tombstone document (200)
 * const softDeleted = Group.make(
 *   Article,
 *   Endpoint.delete(Article, { success: Article.document(), errors: [ArticleNotFound] })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
const deleteEndpoint = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "delete",
  const Path extends `/${string}` = `/${Type}/:id`,
  Success extends Schema.Top = HttpApiSchema.NoContent
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: CommonOptions<Name, Path, Errors> & {
    /**
     * Override the success response schema. Defaults to
     * `HttpApiSchema.NoContent` (204, empty body); pass the resource's
     * `document()` for a soft delete that answers with the tombstone
     * resource, or any schema of your own — it is served as
     * `application/vnd.api+json`.
     */
    readonly success?: Success
    /**
     * The success status. Defaults to 204 for the no-content default, 200 for
     * a `success` override.
     */
    readonly status?: number
  }
) =>
  HttpApiEndpoint.delete((options?.name ?? "delete") as Name, (options?.path ?? `/${resource.type}/:id`) as Path, {
    params: { id: resource.Id },
    success: deleteSuccess(options?.success, options?.status) as Success,
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
    error: wires(options?.errors)
  })
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

export {
  /**
   * `DELETE /<type>/:id` — delete a resource. See {@link deleteEndpoint}.
   *
   * @since 0.1.0
   * @category constructors
   */
  deleteEndpoint as delete
}

// ---------------------------------------------------------------------------
// collection — GET <path>, heterogeneous collection
// ---------------------------------------------------------------------------

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)]

/**
 * The default compound `included` union of a heterogeneous collection
 * endpoint: every resource directly referenced by any of the member
 * resources' relationships.
 *
 * @since 0.1.0
 * @category models
 */
export interface CollectionIncluded<Resources extends ReadonlyArray<Any>> extends Schema.Union<
  ReadonlyArray<TargetsOf<Resources[number]>>
> {}

/**
 * A heterogeneous collection endpoint: `data` is a mixed array of several
 * resource types, discriminated by their `type` tags. The natural fit for
 * search results, feeds and timelines.
 *
 * A polymorphic collection has no single owning resource and thus no
 * conventional route, so `name` and `path` are required rather than defaulted.
 *
 * Success is a 200 collection document whose `data` member is the union of
 * the given resources and whose `included` union spans all of their
 * relationship targets.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person)
 *   }
 * })
 *
 * const search = Group.make(
 *   "search",
 *   // GET /search?filter[q]=bikeshed&include=author&page[offset]=0&page[limit]=10
 *   Endpoint.collection([Article, Person], {
 *     name: "search",
 *     path: "/search",
 *     filter: { q: Schema.String },
 *     include: true,
 *     fields: true,
 *     page: Query.Page.Offset
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
export const collection = <
  const Resources extends ReadonlyArray<Any>,
  const Name extends string,
  const Path extends `/${string}`,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Include extends Query.IncludeOption<Resources[number]> = false,
  const Fields extends boolean = false,
  const Sort extends boolean | ReadonlyArray<AttributeKeys<Resources[number]>> = false,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  const FilterFields extends Schema.Struct.Fields | undefined = undefined,
  DocMeta extends Schema.Top = typeof AnyMeta
>(
  resources: Resources,
  options: {
    /** Endpoint name within its group (required — a polymorphic collection has no conventional name). */
    readonly name: Name
    /** Route path, e.g. `/search` or `/feed` (required — a polymorphic collection has no conventional path). */
    readonly path: Path
    /** `ApiError` classes this endpoint can fail with. */
    readonly errors?: Errors
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
  HttpApiEndpoint.get(options.name as Name, options.path as Path, {
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
        ) as unknown as CollectionIncluded<Resources>,
        meta: (options.meta ?? AnyMeta) as DocMeta
      })
    ),
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
    error: wires(options.errors)
  })
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// polymorphic — GET /<family>/:id (single resource, any family member)
// ---------------------------------------------------------------------------

/**
 * `GET /<family>/:id` — fetch a single resource that may be any member of a
 * {@link Resource.family} (e.g. `GET /nodes/:id` returning a person or an
 * organisation).
 *
 * Success is a 200 single-resource document whose primary `data` is the family's
 * member union (discriminated by `type`) and whose `included` spans every
 * member's targets. The `:id` param is the family's shared id, and `?include=` /
 * `?fields[TYPE]=` span all members' graphs.
 *
 * For the collection case (`GET /nodes`) use {@link collection} with
 * `family.members`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Node = Resource.make("nodes", { attributes: { name: Schema.NonEmptyString } })
 * const Person = Resource.extend(Node, "people", { inheritId: true })
 * const Organisation = Resource.extend(Node, "organisations", { inheritId: true })
 * const AnyNode = Resource.family(Node, [Person, Organisation])
 *
 * const nodes = Group.make(
 *   AnyNode,
 *   Endpoint.polymorphic(AnyNode, { include: true }) // GET /nodes/:id → person | organisation
 * )
 * ```
 *
 * @since 0.4.0
 * @category constructors
 */
export const polymorphic = <
  FamilyName extends string,
  Members extends ReadonlyArray<Any>,
  Base extends Any | undefined,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "get",
  const Path extends `/${string}` = `/${FamilyName}/:id`,
  const Include extends Query.IncludeOption<Members[number]> = false,
  const Fields extends boolean = false,
  DocMeta extends Schema.Top = typeof AnyMeta
>(
  family: Family<FamilyName, Members, Base>,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Enable the `?include=` query parameter (paths span all members' graphs). */
    readonly include?: Include
    /** Enable `?fields[TYPE]=` sparse fieldsets for all members and their targets. */
    readonly fields?: Fields
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta
  }
) =>
  HttpApiEndpoint.get((options?.name ?? "get") as Name, (options?.path ?? `/${family.type}/:id`) as Path, {
    params: { id: family.Id },
    query: Query.schema(
      family.members as ReadonlyArray<Members[number]>,
      queryConfig(options) as {
        readonly include: Include
        readonly fields: Fields
        readonly sort: false
        readonly page: undefined
        readonly filter: undefined
      }
    ),
    success: asJsonApi(
      family.document((options?.meta !== undefined ? { meta: options.meta } : {}) as { readonly meta?: DocMeta })
    ),
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
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
 *   - to-one relationships → a single-resource document of the target with
 *     *nullable* primary `data` (`data: target | null`) — the spec permits an
 *     empty-linkage `data: null` for a to-one related URL
 *   - to-many relationships → a collection document of the target
 *
 * @since 0.1.0
 * @category type-level
 */
export type RelatedSuccess<R extends Any, Name extends string, DocMeta extends Schema.Top> =
  DescriptorOf<R, Name> extends Relationship.ToOne<infer T extends Any>
    ? DataDocument<Schema.NullOr<T>, DefaultIncluded<T["relationships"]>, DocMeta>
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
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // GET /articles/:id/author — the author, as a full resource
 *   Endpoint.related(Article, "author", { errors: [ArticleNotFound] }),
 *   // GET /articles/:id/comments?page[offset]=0&page[limit]=10&include=author
 *   Endpoint.related(Article, "comments", {
 *     include: true,
 *     page: Query.Page.Offset,
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
  const Include extends Query.IncludeOption<Target<Resource<Type, Attributes, Rels, Meta>, Name>> = false,
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
  // The cast is sound: the runtime schema mirrors `RelatedSuccess` exactly — a
  // nullable single-resource document for to-one descriptors (`data: null` is
  // the empty-linkage case), a collection document otherwise. `included` keys
  // off the target's relationship graph, independent of the `data` wrapper.
  const success = (Relationship.isToOne(descriptor)
    ? DataDocument(Schema.NullOr(target), { included, meta: docMeta })
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
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
      error: wires(options?.errors)
    }
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)
}

// ---------------------------------------------------------------------------
// getRelationship — GET /<type>/:id/relationships/<name>
// ---------------------------------------------------------------------------

/**
 * `GET /<type>/:id/relationships/<name>` — get a relationship's linkage.
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
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // GET /articles/:id/relationships/comments?page[offset]=0&page[limit]=10
 *   Endpoint.getRelationship(Article, "comments", {
 *     page: Query.Page.Offset,
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-relationships}
 * @since 0.1.0
 * @category constructors
 */
export const getRelationship = <
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
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
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
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // PATCH /articles/:id/relationships/author — replace the author
 *   Endpoint.updateRelationship(Article, "author", {
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
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
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
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // POST /articles/:id/relationships/comments — attach existing comments
 *   Endpoint.addRelationship(Article, "comments", {
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
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
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
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // DELETE /articles/:id/relationships/comments → 204 — detach comments
 *   Endpoint.removeRelationship(Article, "comments", {
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
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
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
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class OperationFailed extends ApiError.make<OperationFailed>()("OperationFailed", {
 *   status: 422,
 *   fields: { operation: Schema.Int, reason: Schema.String }
 * }) {}
 *
 * const operations = Group.make(
 *   "operations",
 *   // POST /operations with an atomic:operations document
 *   Endpoint.operations([Article, Comment], {
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
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
    error: wires(options?.errors)
  })
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors)

// ---------------------------------------------------------------------------
// resource — generate an entire endpoint set from a resource definition
// ---------------------------------------------------------------------------

/**
 * The CRUD operation names {@link resource} can emit.
 *
 * @since 0.1.0
 * @category models
 */
export type CrudOperation = "get" | "list" | "create" | "update" | "delete"

/**
 * A `meta` option for a generated document: a `Schema` (overriding the meta
 * schema) or a function that builds one from the resource's base meta schema
 * (extending rather than replacing it).
 *
 * @since 0.1.0
 * @category models
 */
export type MetaOption<Meta extends Schema.Top> = Schema.Top | ((base: Meta) => Schema.Top)

/**
 * Per-endpoint configuration for the read-one (`get`) endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface GetConfig<Meta extends Schema.Top, R extends Any = Any> {
  readonly name?: string
  readonly path?: `/${string}`
  readonly errors?: ReadonlyArray<ErrorClass>
  /**
   * Enable `?include=`. `true` legalises the resource's whole relationship
   * graph to a depth of 2; a `Query.IncludeOptions` object constrains that to
   * an explicit `paths` allow-list and/or a `depth` bound.
   */
  readonly include?: Query.IncludeOption<R>
  readonly fields?: boolean
  readonly meta?: MetaOption<Meta>
}

/**
 * Per-endpoint configuration for the collection (`list`) endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface ListConfig<R extends Any, Meta extends Schema.Top> extends GetConfig<Meta, R> {
  readonly sort?: boolean | ReadonlyArray<AttributeKeys<R>>
  readonly page?: Schema.Struct.Fields
  readonly filter?: Schema.Struct.Fields
  /**
   * Override the whole query schema. Defaults to the `Query.schema`
   * composition of `include` / `fields` / `sort` / `page` / `filter`; pass any
   * schema for a list contract of your own.
   */
  readonly query?: Schema.Top
}

/**
 * Per-endpoint configuration for the `create` / `update` endpoints.
 *
 * @since 0.1.0
 * @category models
 */
export interface WriteConfig<Meta extends Schema.Top> {
  readonly name?: string
  readonly path?: `/${string}`
  readonly errors?: ReadonlyArray<ErrorClass>
  readonly meta?: MetaOption<Meta>
  /**
   * Override the request payload schema. Defaults to the resource's
   * `createPayload` / `updatePayload` (the JSON:API envelope); pass the
   * resource's flat `createInput` / `updateInput`, or any schema of your own.
   */
  readonly payload?: Schema.Top
}

/**
 * Per-endpoint configuration for the `delete` endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface DeleteConfig {
  readonly name?: string
  readonly path?: `/${string}`
  readonly errors?: ReadonlyArray<ErrorClass>
  /**
   * Override the success response schema. Defaults to `HttpApiSchema.NoContent`
   * (204, empty body); pass the resource's `document()` for a soft delete that
   * answers with the tombstone resource, or any schema of your own.
   */
  readonly success?: Schema.Top
  /**
   * The success status. Defaults to 204 for the no-content default, 200 for a
   * `success` override.
   */
  readonly status?: number
}

/**
 * The `endpoints` option: an object keyed by CRUD operation. Each value is
 * `true` (emit with the top-level defaults), `false` (omit), or an object
 * configuring that endpoint (overriding the top-level defaults). Operations
 * not mentioned are emitted with the defaults.
 *
 * @since 0.1.0
 * @category models
 */
export interface EndpointsOption<R extends Any, Meta extends Schema.Top> {
  readonly get?: boolean | GetConfig<Meta, R>
  readonly list?: boolean | ListConfig<R, Meta>
  readonly create?: boolean | WriteConfig<Meta>
  readonly update?: boolean | WriteConfig<Meta>
  readonly delete?: boolean | DeleteConfig
}

/**
 * Per-relationship configuration for a relationship's generated endpoints.
 *
 * @since 0.1.0
 * @category models
 */
export interface RelationshipConfig {
  readonly errors?: ReadonlyArray<ErrorClass>
  readonly include?: boolean
  readonly fields?: boolean
  readonly sort?: boolean
  readonly page?: Schema.Struct.Fields
}

/**
 * The `relationships` option: `true` (all relationships, the default) or
 * `false` (none) as a shorthand, or an object keyed by relationship name —
 * each `false` to exclude that relationship, or an object to configure its
 * endpoints. Relationships not mentioned are emitted with the top-level
 * defaults.
 *
 * @since 0.1.0
 * @category models
 */
export type RelationshipsOption<R extends Any> =
  | boolean
  | { readonly [K in RelationshipName<R>]?: boolean | RelationshipConfig }

// --- extraction helpers (config objects are captured via `const`) ----------

// The captured config object for CRUD op `Op` (or `{}` when absent / boolean).
type ConfigObject<E, Op extends string> = E extends undefined
  ? {}
  : Op extends keyof E
    ? NonNullable<E[Op]> extends infer V
      ? V extends boolean
        ? {}
        : V
      : {}
    : {}

// Field `K` of config object `C`, else fallback `F`.
type FieldOr<C, K extends string, F> = K extends keyof C ? Exclude<C[K], undefined> : F

// Whether CRUD op `Op` is emitted: absent → emit; `false` → omit; else emit.
type EmitOp<E, Op extends string> = E extends undefined
  ? true
  : Op extends keyof E
    ? NonNullable<E[Op]> extends false
      ? false
      : true
    : true

// The captured config object for relationship `K` (or `{}`).
type RelConfigObject<RO, K extends string> = RO extends boolean
  ? {}
  : RO extends undefined
    ? {}
    : K extends keyof RO
      ? NonNullable<RO[K]> extends infer V
        ? V extends boolean
          ? {}
          : V
        : {}
      : {}

// Whether relationship `K` is emitted.
type EmitRel<RO, K extends string> = RO extends false
  ? false
  : RO extends true
    ? true
    : RO extends undefined
      ? true
      : K extends keyof RO
        ? NonNullable<RO[K]> extends false
          ? false
          : true
        : true

// Resolve a meta option (schema or function) to its effective schema type.
type ResolveMeta<M, Meta extends Schema.Top> = [M] extends [(...args: any) => infer Ret]
  ? Ret extends Schema.Top
    ? Ret
    : Meta
  : M extends Schema.Top
    ? M
    : Meta

type EffMeta<C, GMeta, Meta extends Schema.Top> = ResolveMeta<FieldOr<C, "meta", GMeta>, Meta>

// The effective write payload of a `create` / `update` config: the captured
// `payload` override, else the resource's enveloped default.
type EffPayload<C, Default extends Schema.Top> =
  FieldOr<C, "payload", Default> extends infer P ? (P extends Schema.Top ? P : Default) : Default

// The effective success response of a `delete` config: the captured `success`
// override, else the 204 no-content default.
type EffSuccess<C, Default extends Schema.Top> =
  FieldOr<C, "success", Default> extends infer S ? (S extends Schema.Top ? S : Default) : Default

// The effective query schema of a `list` config: the captured `query`
// override, else the `Query.schema` composition of its feature options.
type EffQuery<C, Default extends Schema.Top> =
  FieldOr<C, "query", Default> extends infer Q ? (Q extends Schema.Top ? Q : Default) : Default

// Whether `sort` is enabled at all: `false` only when explicitly disabled.
type EnabledSort<Sort> = [Sort] extends [false] ? false : true

// Whether `include` is enabled at all. A `Query.IncludeOptions` object
// constrains the *resource's own* paths, which a relationship endpoint — whose
// graph is its target's — can't reuse; it only learns that the parameter is on.
type EnabledInclude<Include> = [Include] extends [false] ? false : true

// The effective query feature options of a `get` / `list` config: the captured
// override, else the top-level default. Named (rather than inlined at each use
// site) because `list` needs them twice — once as its own options, once to
// reconstruct the query schema they compose by default.
type ListInclude<C, R extends Any, GInclude extends Query.IncludeOption<R>> =
  FieldOr<C, "include", GInclude> extends Query.IncludeOption<R> ? FieldOr<C, "include", GInclude> : GInclude
type ListFields<C, GFields extends boolean> =
  FieldOr<C, "fields", GFields> extends boolean ? FieldOr<C, "fields", GFields> : GFields
type ListSort<C, R extends Any, GSort extends boolean | ReadonlyArray<AttributeKeys<R>>> =
  FieldOr<C, "sort", GSort> extends boolean | ReadonlyArray<AttributeKeys<R>> ? FieldOr<C, "sort", GSort> : GSort
type ListPage<C, GPage extends Schema.Struct.Fields | undefined> =
  FieldOr<C, "page", GPage> extends Schema.Struct.Fields | undefined ? FieldOr<C, "page", GPage> : GPage
type ListFilter<C, GFilter extends Schema.Struct.Fields | undefined> =
  FieldOr<C, "filter", GFilter> extends Schema.Struct.Fields | undefined ? FieldOr<C, "filter", GFilter> : GFilter

// --- the effective generated endpoint types --------------------------------

type GeneratedGet<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  GInclude extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta>>,
  GFields extends boolean,
  GMeta,
  C = ConfigObject<E, "get">
> =
  EmitOp<E, "get"> extends true
    ? ReturnType<
        typeof get<
          Type,
          Attributes,
          Rels,
          Meta,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass> ? FieldOr<C, "errors", GErrors> : GErrors,
          FieldOr<C, "name", "get"> extends string ? FieldOr<C, "name", "get"> : "get",
          FieldOr<C, "path", `/${Type}/:id`> extends `/${string}` ? FieldOr<C, "path", `/${Type}/:id`> : `/${Type}/:id`,
          ListInclude<C, Resource<Type, Attributes, Rels, Meta>, GInclude>,
          ListFields<C, GFields>,
          EffMeta<C, GMeta, Meta>
        >
      >
    : never

type GeneratedList<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  GInclude extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta>>,
  GFields extends boolean,
  GSort extends boolean | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta>>>,
  GPage extends Schema.Struct.Fields | undefined,
  GFilter extends Schema.Struct.Fields | undefined,
  GMeta,
  C = ConfigObject<E, "list">
> =
  EmitOp<E, "list"> extends true
    ? ReturnType<
        typeof list<
          Type,
          Attributes,
          Rels,
          Meta,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass> ? FieldOr<C, "errors", GErrors> : GErrors,
          FieldOr<C, "name", "list"> extends string ? FieldOr<C, "name", "list"> : "list",
          FieldOr<C, "path", `/${Type}`> extends `/${string}` ? FieldOr<C, "path", `/${Type}`> : `/${Type}`,
          ListInclude<C, Resource<Type, Attributes, Rels, Meta>, GInclude>,
          ListFields<C, GFields>,
          ListSort<C, Resource<Type, Attributes, Rels, Meta>, GSort>,
          ListPage<C, GPage>,
          ListFilter<C, GFilter>,
          EffMeta<C, GMeta, Meta>,
          EffQuery<
            C,
            DefaultListQuery<
              Type,
              Attributes,
              Rels,
              Meta,
              ListInclude<C, Resource<Type, Attributes, Rels, Meta>, GInclude>,
              ListFields<C, GFields>,
              ListSort<C, Resource<Type, Attributes, Rels, Meta>, GSort>,
              ListPage<C, GPage>,
              ListFilter<C, GFilter>
            >
          >
        >
      >
    : never

type GeneratedCreate<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  GMeta,
  C = ConfigObject<E, "create">
> =
  EmitOp<E, "create"> extends true
    ? ReturnType<
        typeof create<
          Type,
          Attributes,
          Rels,
          Meta,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass> ? FieldOr<C, "errors", GErrors> : GErrors,
          FieldOr<C, "name", "create"> extends string ? FieldOr<C, "name", "create"> : "create",
          FieldOr<C, "path", `/${Type}`> extends `/${string}` ? FieldOr<C, "path", `/${Type}`> : `/${Type}`,
          EffMeta<C, GMeta, Meta>,
          EffPayload<C, Resource<Type, Attributes, Rels, Meta>["createPayload"]>
        >
      >
    : never

type GeneratedUpdate<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  GMeta,
  C = ConfigObject<E, "update">
> =
  EmitOp<E, "update"> extends true
    ? ReturnType<
        typeof update<
          Type,
          Attributes,
          Rels,
          Meta,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass> ? FieldOr<C, "errors", GErrors> : GErrors,
          FieldOr<C, "name", "update"> extends string ? FieldOr<C, "name", "update"> : "update",
          FieldOr<C, "path", `/${Type}/:id`> extends `/${string}` ? FieldOr<C, "path", `/${Type}/:id`> : `/${Type}/:id`,
          EffMeta<C, GMeta, Meta>,
          EffPayload<C, Resource<Type, Attributes, Rels, Meta>["updatePayload"]>
        >
      >
    : never

type GeneratedDelete<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  C = ConfigObject<E, "delete">
> =
  EmitOp<E, "delete"> extends true
    ? ReturnType<
        typeof deleteEndpoint<
          Type,
          Attributes,
          Rels,
          Meta,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass> ? FieldOr<C, "errors", GErrors> : GErrors,
          FieldOr<C, "name", "delete"> extends string ? FieldOr<C, "name", "delete"> : "delete",
          FieldOr<C, "path", `/${Type}/:id`> extends `/${string}` ? FieldOr<C, "path", `/${Type}/:id`> : `/${Type}/:id`,
          EffSuccess<C, HttpApiSchema.NoContent>
        >
      >
    : never

// per-relationship effective option helpers
type RelErrors<RC, GErrors extends ReadonlyArray<ErrorClass>> =
  FieldOr<RC, "errors", GErrors> extends ReadonlyArray<ErrorClass> ? FieldOr<RC, "errors", GErrors> : GErrors
type RelInclude<RC, GInclude extends boolean> =
  FieldOr<RC, "include", GInclude> extends boolean ? FieldOr<RC, "include", GInclude> : GInclude
type RelFields<RC, GFields extends boolean> =
  FieldOr<RC, "fields", GFields> extends boolean ? FieldOr<RC, "fields", GFields> : GFields
type RelPage<RC, GPage extends Schema.Struct.Fields | undefined> =
  FieldOr<RC, "page", GPage> extends Schema.Struct.Fields | undefined ? FieldOr<RC, "page", GPage> : GPage

type GeneratedRelated<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  K extends RelationshipName<Resource<Type, Attributes, Rels, Meta>>,
  RC,
  GErrors extends ReadonlyArray<ErrorClass>,
  GInclude extends boolean,
  GFields extends boolean,
  GSort,
  GPage extends Schema.Struct.Fields | undefined
> =
  Rels[K] extends Relationship.ToMany<Any>
    ? ReturnType<
        typeof related<
          Type,
          Attributes,
          Rels,
          Meta,
          K,
          RelErrors<RC, GErrors>,
          K,
          `/${Type}/:id/${K}`,
          RelInclude<RC, GInclude>,
          RelFields<RC, GFields>,
          EnabledSort<FieldOr<RC, "sort", GSort>>,
          RelPage<RC, GPage>,
          undefined,
          typeof AnyMeta
        >
      >
    : ReturnType<
        typeof related<
          Type,
          Attributes,
          Rels,
          Meta,
          K,
          RelErrors<RC, GErrors>,
          K,
          `/${Type}/:id/${K}`,
          RelInclude<RC, GInclude>,
          RelFields<RC, GFields>,
          false,
          undefined,
          undefined,
          typeof AnyMeta
        >
      >

type GeneratedRelationships<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  RO,
  GErrors extends ReadonlyArray<ErrorClass>,
  GInclude extends boolean,
  GFields extends boolean,
  GSort,
  GPage extends Schema.Struct.Fields | undefined
> =
  | {
      readonly [K in RelationshipName<Resource<Type, Attributes, Rels, Meta>>]: EmitRel<RO, K> extends true
        ?
            | GeneratedRelated<
                Type,
                Attributes,
                Rels,
                Meta,
                K,
                RelConfigObject<RO, K>,
                GErrors,
                GInclude,
                GFields,
                GSort,
                GPage
              >
            | ReturnType<
                typeof getRelationship<
                  Type,
                  Attributes,
                  Rels,
                  Meta,
                  K,
                  RelErrors<RelConfigObject<RO, K>, GErrors>,
                  `${K}Relationship`,
                  `/${Type}/:id/relationships/${K}`,
                  Rels[K] extends Relationship.ToMany<Any> ? RelPage<RelConfigObject<RO, K>, GPage> : undefined,
                  typeof AnyMeta
                >
              >
            | ReturnType<
                typeof updateRelationship<
                  Type,
                  Attributes,
                  Rels,
                  Meta,
                  K,
                  RelErrors<RelConfigObject<RO, K>, GErrors>,
                  `update${Capitalize<K>}Relationship`,
                  `/${Type}/:id/relationships/${K}`,
                  typeof AnyMeta
                >
              >
        : never
    }[RelationshipName<Resource<Type, Attributes, Rels, Meta>>]
  | {
      readonly [K in ToManyName<Resource<Type, Attributes, Rels, Meta>>]: EmitRel<RO, K> extends true
        ?
            | ReturnType<
                typeof addRelationship<
                  Type,
                  Attributes,
                  Rels,
                  Meta,
                  K,
                  RelErrors<RelConfigObject<RO, K>, GErrors>,
                  `add${Capitalize<K>}Relationship`,
                  `/${Type}/:id/relationships/${K}`,
                  typeof AnyMeta
                >
              >
            | ReturnType<
                typeof removeRelationship<
                  Type,
                  Attributes,
                  Rels,
                  Meta,
                  K,
                  RelErrors<RelConfigObject<RO, K>, GErrors>,
                  `remove${Capitalize<K>}Relationship`,
                  `/${Type}/:id/relationships/${K}`
                >
              >
        : never
    }[ToManyName<Resource<Type, Attributes, Rels, Meta>>]

/**
 * The union of every endpoint {@link resource} emits for a resource and its
 * configuration.
 *
 * @since 0.1.0
 * @category type-level
 */
export type ResourceEndpoint<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  Endpoints,
  RelationshipsOpt,
  Errors extends ReadonlyArray<ErrorClass>,
  Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta>>,
  Fields extends boolean,
  Sort extends boolean | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta>>>,
  Page extends Schema.Struct.Fields | undefined,
  Filter extends Schema.Struct.Fields | undefined,
  GMeta
> =
  | GeneratedGet<Type, Attributes, Rels, Meta, Endpoints, Errors, Include, Fields, GMeta>
  | GeneratedList<Type, Attributes, Rels, Meta, Endpoints, Errors, Include, Fields, Sort, Page, Filter, GMeta>
  | GeneratedCreate<Type, Attributes, Rels, Meta, Endpoints, Errors, GMeta>
  | GeneratedUpdate<Type, Attributes, Rels, Meta, Endpoints, Errors, GMeta>
  | GeneratedDelete<Type, Attributes, Rels, Meta, Endpoints, Errors>
  | GeneratedRelationships<
      Type,
      Attributes,
      Rels,
      Meta,
      RelationshipsOpt,
      Errors,
      EnabledInclude<Include>,
      Fields,
      Sort,
      Page
    >

/**
 * The non-empty tuple of endpoints {@link resource} returns.
 *
 * @since 0.1.0
 * @category type-level
 */
export type ResourceEndpoints<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  Endpoints,
  RelationshipsOpt,
  Errors extends ReadonlyArray<ErrorClass>,
  Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta>>,
  Fields extends boolean,
  Sort extends boolean | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta>>>,
  Page extends Schema.Struct.Fields | undefined,
  Filter extends Schema.Struct.Fields | undefined,
  GMeta
> = readonly [
  ResourceEndpoint<
    Type,
    Attributes,
    Rels,
    Meta,
    Endpoints,
    RelationshipsOpt,
    Errors,
    Include,
    Fields,
    Sort,
    Page,
    Filter,
    GMeta
  >,
  ...ReadonlyArray<
    ResourceEndpoint<
      Type,
      Attributes,
      Rels,
      Meta,
      Endpoints,
      RelationshipsOpt,
      Errors,
      Include,
      Fields,
      Sort,
      Page,
      Filter,
      GMeta
    >
  >
]

/**
 * Configuration for {@link resource} — the whole-resource endpoint generator.
 *
 * Every field is optional; the defaults emit the full CRUD set, every
 * relationship's endpoints, and derived `include` / `fields` / `sort`
 * parameters.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResourceOptions<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  Endpoints extends EndpointsOption<Resource<Type, Attributes, Rels, Meta>, Meta>,
  RelationshipsOpt extends RelationshipsOption<Resource<Type, Attributes, Rels, Meta>>,
  Errors extends ReadonlyArray<ErrorClass>,
  Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta>>,
  Fields extends boolean,
  Sort extends boolean | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta>>>,
  Page extends Schema.Struct.Fields | undefined,
  Filter extends Schema.Struct.Fields | undefined,
  GMeta extends Schema.Top
> {
  /** Which CRUD endpoints to emit and how to configure each. Defaults to all five. */
  readonly endpoints?: Endpoints
  /** Which relationships' endpoints to emit. `true` (all, default) / `false` (none) or a per-relationship object. */
  readonly relationships?: RelationshipsOpt
  /** `ApiError` classes applied to every generated endpoint (overridable per endpoint / relationship). */
  readonly errors?: Errors
  /**
   * Enable `?include=` on the collection-bearing endpoints. Defaults to `true`
   * — the resource's whole relationship graph at depth 2. A
   * `Query.IncludeOptions` object constrains that (`paths` allow-list and/or
   * `depth`) for `get` and `list`; the relationship endpoints, whose paths are
   * their target's graph, only see that `include` is on.
   */
  readonly include?: Include
  /** Enable `?fields[TYPE]=` sparse fieldsets. Defaults to `true`. */
  readonly fields?: Fields
  /** Enable `?sort=`: `true` for all attributes, an explicit list, or `false` to disable. Defaults to `true`. */
  readonly sort?: Sort
  /** Enable `?page[*]=` on `list`, to-many `related` and paginated-linkage endpoints (see `Query.Page`). */
  readonly page?: Page
  /** Enable `?filter[*]=` on `list` (user-defined fields). */
  readonly filter?: Filter
  /**
   * The `meta` schema of the primary-data documents (`get` / `list` / `create`
   * / `update`): a `Schema` (overriding it) or a function `(base) => schema`
   * (extending the resource's base meta rather than replacing it).
   */
  readonly meta?: GMeta | ((base: Meta) => GMeta)
}

const pick = (config: Record<string, unknown>, key: string, fallback: unknown): unknown =>
  key in config ? config[key] : fallback

/**
 * Generates the entire JSON:API endpoint set for a resource definition — the
 * full CRUD surface plus, for every relationship, the `related` and linkage
 * endpoints appropriate to its kind — with `include`, `fields` and `sort`
 * query parameters derived from the resource graph.
 *
 * The result is a plain tuple of `HttpApiEndpoint` values, ready to spread into
 * {@link Group.make} (or `Group.resource`, which does exactly that). Trim or
 * extend it like any array; override individual endpoints by replacing them.
 *
 * Defaults (all overridable):
 *   - emits `get`, `list`, `create`, `update`, `delete` (configure with `endpoints`)
 *   - emits every relationship's endpoints (configure with `relationships`)
 *   - enables `include`, `fields` and `sort` (derived from the graph & attributes)
 *   - leaves `page` and `filter` off (their semantics are application-defined)
 *   - applies `errors` to every generated endpoint, overridable per endpoint / relationship
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/unstable/httpapi"
 * import { ApiError, Endpoint, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     comments: Relationship.paginated(() => Person)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 * class TitleTaken extends ApiError.make<TitleTaken>()("TitleTaken", {
 *   status: 409,
 *   fields: { title: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   ...Endpoint.resource(Article, {
 *     errors: [ArticleNotFound],
 *     page: Query.Page.Offset,
 *     // per-endpoint config overrides the top-level defaults:
 *     endpoints: {
 *       create: { errors: [TitleTaken] },
 *       list: { filter: { author: Schema.optionalKey(Schema.String) } }
 *     }
 *   })
 * )
 *
 * const Api = HttpApi.make("blog").add(articles)
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const resource = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  const Endpoints extends EndpointsOption<Resource<Type, Attributes, Rels, Meta>, Meta> = {},
  const RelationshipsOpt extends RelationshipsOption<Resource<Type, Attributes, Rels, Meta>> = true,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta>> = true,
  const Fields extends boolean = true,
  const Sort extends boolean | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta>>> = true,
  const Page extends Schema.Struct.Fields | undefined = undefined,
  const Filter extends Schema.Struct.Fields | undefined = undefined,
  const GMeta extends Schema.Top = Meta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: ResourceOptions<
    Type,
    Attributes,
    Rels,
    Meta,
    Endpoints,
    RelationshipsOpt,
    Errors,
    Include,
    Fields,
    Sort,
    Page,
    Filter,
    GMeta
  >
): ResourceEndpoints<
  Type,
  Attributes,
  Rels,
  Meta,
  Endpoints,
  RelationshipsOpt,
  Errors,
  Include,
  Fields,
  Sort,
  Page,
  Filter,
  GMeta
> => {
  const gInclude = options?.include ?? true
  const gFields = options?.fields ?? true
  const gSort = options?.sort ?? true
  const gPage = options?.page
  const gFilter = options?.filter
  const gMeta = options?.meta
  const gErrors = options?.errors
  const endpointsOpt = options?.endpoints as Record<string, unknown> | undefined
  const relationshipsOpt = options?.relationships ?? true

  // The resource's base meta schema, for resolving `meta` functions.
  const baseMeta = (resource.fields.meta as { readonly schema: Schema.Top }).schema
  const resolveMeta = (value: unknown): Schema.Top | undefined =>
    value === undefined
      ? undefined
      : typeof value === "function"
        ? (value as (base: Schema.Top) => Schema.Top)(baseMeta)
        : (value as Schema.Top)

  // Emit + captured config for a CRUD op.
  const opConfig = (op: CrudOperation): { readonly emit: boolean; readonly config: Record<string, unknown> } => {
    if (endpointsOpt === undefined) return { emit: true, config: {} }
    const value = endpointsOpt[op]
    if (value === undefined || value === true) return { emit: true, config: {} }
    if (value === false) return { emit: false, config: {} }
    return { emit: true, config: value as Record<string, unknown> }
  }

  // The shared name / path / errors (and, optionally, meta) overrides of an op.
  const commonOpts = (config: Record<string, unknown>, withMeta: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const errors = pick(config, "errors", gErrors)
    if (errors !== undefined) out.errors = errors
    if ("name" in config) out.name = config.name
    if ("path" in config) out.path = config.path
    if (withMeta) {
      const meta = resolveMeta(pick(config, "meta", gMeta))
      if (meta !== undefined) out.meta = meta
    }
    return out
  }

  const endpoints: Array<HttpApiEndpoint.Top> = []

  const getOp = opConfig("get")
  if (getOp.emit) {
    endpoints.push(
      get(resource, {
        include: pick(getOp.config, "include", gInclude),
        fields: pick(getOp.config, "fields", gFields),
        ...commonOpts(getOp.config, true)
      } as never)
    )
  }
  // A `list` endpoint's `query` override is per-endpoint only: it replaces the
  // whole composed query, which no other generated endpoint shares, so there is
  // no sensible top-level default to fall back to.
  const listOp = opConfig("list")
  if (listOp.emit) {
    const page = pick(listOp.config, "page", gPage)
    const filter = pick(listOp.config, "filter", gFilter)
    endpoints.push(
      list(resource, {
        include: pick(listOp.config, "include", gInclude),
        fields: pick(listOp.config, "fields", gFields),
        sort: pick(listOp.config, "sort", gSort),
        ...(page !== undefined ? { page } : {}),
        ...(filter !== undefined ? { filter } : {}),
        ...(listOp.config.query !== undefined ? { query: listOp.config.query } : {}),
        ...commonOpts(listOp.config, true)
      } as never)
    )
  }
  // A write endpoint's `payload` override is per-endpoint only: `create` and
  // `update` have different default envelopes, so there is no sensible
  // top-level default to fall back to.
  const payloadOpt = (config: Record<string, unknown>): Record<string, unknown> =>
    config.payload !== undefined ? { payload: config.payload } : {}

  const createOp = opConfig("create")
  if (createOp.emit) {
    endpoints.push(create(resource, { ...commonOpts(createOp.config, true), ...payloadOpt(createOp.config) } as never))
  }
  const updateOp = opConfig("update")
  if (updateOp.emit) {
    endpoints.push(update(resource, { ...commonOpts(updateOp.config, true), ...payloadOpt(updateOp.config) } as never))
  }
  // A `delete` endpoint's success override is per-endpoint only: no other
  // generated endpoint answers with no content, so there is no sensible
  // top-level default to fall back to.
  const deleteOp = opConfig("delete")
  if (deleteOp.emit) {
    endpoints.push(
      deleteEndpoint(resource, {
        ...commonOpts(deleteOp.config, false),
        ...(deleteOp.config.success !== undefined ? { success: deleteOp.config.success } : {}),
        ...(deleteOp.config.status !== undefined ? { status: deleteOp.config.status } : {})
      } as never)
    )
  }

  if (relationshipsOpt !== false) {
    const relMap = typeof relationshipsOpt === "object" ? (relationshipsOpt as Record<string, unknown>) : undefined
    const relationships = resource.relationships as Record<string, Relationship.Descriptor>
    for (const name of Object.keys(relationships)) {
      let relConfig: Record<string, unknown> = {}
      if (relMap !== undefined) {
        const value = relMap[name]
        if (value === false) continue
        if (value !== undefined && value !== true) relConfig = value as Record<string, unknown>
      }
      const toMany = Relationship.isToMany(relationships[name]!)
      // A constrained `include` names this resource's paths, not the target's:
      // a relationship endpoint only inherits that the parameter is on.
      const inheritedInclude = pick(relConfig, "include", gInclude)
      const include = typeof inheritedInclude === "object" ? true : inheritedInclude
      const fields = pick(relConfig, "fields", gFields)
      const sortOpt = pick(relConfig, "sort", gSort)
      const page = pick(relConfig, "page", gPage)
      const errors = pick(relConfig, "errors", gErrors)
      const errorOpt = errors !== undefined ? { errors } : {}
      const relatedSort = sortOpt === false ? false : true

      endpoints.push(
        related(
          resource,
          name as never,
          {
            include,
            fields,
            ...(toMany ? { sort: relatedSort, ...(page !== undefined ? { page } : {}) } : {}),
            ...errorOpt
          } as never
        )
      )
      endpoints.push(
        getRelationship(
          resource,
          name as never,
          {
            ...(toMany && page !== undefined ? { page } : {}),
            ...errorOpt
          } as never
        )
      )
      endpoints.push(updateRelationship(resource, name as never, { ...errorOpt } as never))
      if (toMany) {
        endpoints.push(addRelationship(resource, name as never, { ...errorOpt } as never))
        endpoints.push(removeRelationship(resource, name as never, { ...errorOpt } as never))
      }
    }
  }

  return endpoints as unknown as ResourceEndpoints<
    Type,
    Attributes,
    Rels,
    Meta,
    Endpoints,
    RelationshipsOpt,
    Errors,
    Include,
    Fields,
    Sort,
    Page,
    Filter,
    GMeta
  >
}
