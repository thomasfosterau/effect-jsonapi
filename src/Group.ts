/**
 * JSON:API resource groups.
 *
 * Light sugar over `HttpApiGroup`: a group named after a resource type (or a
 * plain name, for heterogeneous endpoints like search), holding JSON:API
 * endpoints.
 *
 * ```ts
 * const articles = Group.make(Article,
 *   Endpoint.get(Article, { include: true, errors: [ArticleNotFound] }),
 *   Endpoint.list(Article, { page: Query.Page.Offset }),
 *   Endpoint.create(Article),
 *   Endpoint.update(Article, { errors: [ArticleNotFound] }),
 *   Endpoint.delete(Article, { errors: [ArticleNotFound] })
 * )
 *
 * // …or generate the whole group from the resource definition:
 * const articles = Group.resource(Article, { errors: [ArticleNotFound] })
 *
 * const search = Group.make("search",
 *   Endpoint.collection([Article, Person], { name: "search", path: "/search", filter: { q: Schema.String } })
 * )
 *
 * const Api = HttpApi.make("blog").add(articles).add(search)
 * ```
 *
 * The result is a plain `HttpApiGroup`, so everything composes with vanilla
 * `HttpApi` / `HttpApiBuilder` / `HttpApiClient` / `HttpApiTest` / `OpenApi`.
 *
 * @since 0.1.0
 */
import type { Schema } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import type { HttpApiEndpoint } from "effect/unstable/httpapi"
import { HttpApiGroup } from "effect/unstable/httpapi"
import * as Endpoint from "./Endpoint.js"
import type { Relationships } from "./Relationship.js"
import type { AttributeKeys, Resource } from "./Resource.js"

/**
 * Creates an `HttpApiGroup` named after a resource's type — or after a plain
 * string, for groups that span several resource types — containing the given
 * endpoints.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/unstable/httpapi"
 * import { Endpoint, Group, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 * const Person = Resource.make("people", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * // A group named after a resource type
 * const articles = Group.make(
 *   Article,
 *   Endpoint.get(Article, { include: true }),
 *   Endpoint.list(Article, { page: Query.Page.Offset })
 * )
 *
 * // A group named after a plain string, for heterogeneous endpoints
 * const search = Group.make(
 *   "search",
 *   Endpoint.collection([Article, Person], { name: "search", path: "/search", filter: { q: Schema.String } })
 * )
 *
 * const Api = HttpApi.make("blog").add(articles).add(search)
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: {
  <const Type extends string, const Endpoints extends NonEmptyReadonlyArray<HttpApiEndpoint.Any>>(
    resource: { readonly type: Type },
    ...endpoints: Endpoints
  ): HttpApiGroup.HttpApiGroup<Type, Endpoints[number]>
  <const Name extends string, const Endpoints extends NonEmptyReadonlyArray<HttpApiEndpoint.Any>>(
    name: Name,
    ...endpoints: Endpoints
  ): HttpApiGroup.HttpApiGroup<Name, Endpoints[number]>
} = (nameOrResource: string | { readonly type: string }, ...endpoints: ReadonlyArray<HttpApiEndpoint.Any>) =>
  HttpApiGroup.make(typeof nameOrResource === "string" ? nameOrResource : nameOrResource.type).add(
    ...(endpoints as unknown as NonEmptyReadonlyArray<HttpApiEndpoint.Any>)
  ) as never

/**
 * Generates a complete `HttpApiGroup` from a resource definition — the group is
 * named after the resource's type and contains the full endpoint set produced
 * by {@link Endpoint.resource} (CRUD + relationship endpoints with derived
 * query parameters).
 *
 * This is the one-call "whole group from a resource" ergonomic. For finer
 * control — adding heterogeneous endpoints, dropping or replacing individual
 * endpoints — spread {@link Endpoint.resource} into {@link make} instead.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/unstable/httpapi"
 * import { ApiError, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
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
 *
 * // CRUD + every relationship endpoint, fully typed:
 * const articles = Group.resource(Article, {
 *   errors: [ArticleNotFound],
 *   page: Query.Page.Offset,
 *   endpoints: {
 *     // override the top-level defaults per endpoint:
 *     list: { filter: { author: Schema.optionalKey(Schema.String) } }
 *   }
 * })
 *
 * // A read-only resource: just get + list, no relationship endpoints:
 * const people = Group.resource(Person, {
 *   endpoints: { create: false, update: false, delete: false },
 *   relationships: false
 * })
 *
 * const Api = HttpApi.make("blog").add(articles).add(people)
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
  const Endpoints extends Endpoint.EndpointsOption<Resource<Type, Attributes, Rels, Meta>, Meta> = {},
  const RelationshipsOpt extends Endpoint.RelationshipsOption<Resource<Type, Attributes, Rels, Meta>> = true,
  const Errors extends ReadonlyArray<Endpoint.ErrorClass> = readonly [],
  const Include extends boolean = true,
  const Fields extends boolean = true,
  const Sort extends boolean | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta>>> = true,
  const Page extends Schema.Struct.Fields | undefined = undefined,
  const Filter extends Schema.Struct.Fields | undefined = undefined,
  const GMeta extends Schema.Top = Meta
>(
  resource: Resource<Type, Attributes, Rels, Meta>,
  options?: Endpoint.ResourceOptions<
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
): HttpApiGroup.HttpApiGroup<
  Type,
  Endpoint.ResourceEndpoint<
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
> =>
  make(
    resource,
    ...Endpoint.resource<
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
    >(resource, options)
  )
